// Funcoes compartilhadas: token do Google + helpers da API do Notion.

import { readFileSync, existsSync } from "node:fs";

function loadJson(file) {
  if (!existsSync(file)) {
    console.error(`ERRO: ${file} nao encontrado.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export async function getAccessToken() {
  const client = loadJson("google-client.json").installed;
  const tokens = loadJson("google-tokens.json");
  if (!client || !tokens.refresh_token) {
    console.error("ERRO: credenciais invalidas (google-client.json / google-tokens.json).");
    process.exit(1);
  }
  const resp = await fetch(client.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    console.error(`ERRO refresh FAIL: ${resp.status} ${await resp.text()}`);
    console.error("ACAO: refazer 'npm run auth' (login do Bernardo) e atualizar SOMENTE o secret GOOGLE_TOKENS.");
    process.exit(1);
  }
  const data = await resp.json();
  console.log("OK: access token do Google obtido.");
  return { accessToken: data.access_token, tokens };
}

const NOTION = "https://api.notion.com/v1";

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

export async function notionExistingIds(databaseId, propertyName) {
  const ids = new Set();
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const resp = await fetch(`${NOTION}/databases/${databaseId}/query`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`ERRO Notion query: ${resp.status} ${await resp.text()}`);
      console.error("DICA: confira o ID do database e se a integracao esta conectada a ele (menu ... -> Conexoes).");
      process.exit(1);
    }
    const data = await resp.json();
    for (const page of data.results || []) {
      const prop = page.properties?.[propertyName];
      const txt = (prop?.rich_text || []).map((t) => t.plain_text).join("");
      if (txt) ids.add(txt);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return ids;
}

export async function createNotionPage(databaseId, properties, blocks = []) {
  const first = blocks.slice(0, 100);
  const rest = blocks.slice(100);
  const resp = await fetch(`${NOTION}/pages`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify({ parent: { database_id: databaseId }, properties, children: first }),
  });
  if (!resp.ok) {
    console.error(`ERRO Notion create: ${resp.status} ${await resp.text()}`);
    return false;
  }
  const page = await resp.json();
  for (let i = 0; i < rest.length; i += 100) {
    const r = await fetch(`${NOTION}/blocks/${page.id}/children`, {
      method: "PATCH",
      headers: notionHeaders(),
      body: JSON.stringify({ children: rest.slice(i, i + 100) }),
    });
    if (!r.ok) {
      console.error(`AVISO: falha ao anexar parte do corpo (${r.status}). Pagina criada mesmo assim.`);
      break;
    }
  }
  return true;
}

const cut = (s, n = 1900) => String(s).slice(0, n);

export const pTitle = (s) => ({ title: [{ type: "text", text: { content: cut(s || "(sem titulo)") } }] });
export const pText = (s) => ({ rich_text: s ? [{ type: "text", text: { content: cut(s) } }] : [] });
export const pDate = (iso) => (iso ? { date: { start: iso } } : { date: null });
export const pSelect = (name) => (name ? { select: { name: cut(name, 90) } } : { select: null });
export const pMulti = (names) => ({
  multi_select: (names || []).slice(0, 20).map((n) => ({ name: cut(String(n).replace(/,/g, " "), 90) })),
});
export const pNumber = (n) => ({ number: typeof n === "number" && Number.isFinite(n) ? n : null });
export const pStatus = (name) => ({ status: { name } });

export function paragraphs(text, maxBlocks = 300) {
  const blocks = [];
  const clean = String(text || "").replace(/\r\n/g, "\n");
  for (const part of clean.split(/\n{2,}/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    for (let i = 0; i < trimmed.length; i += 1900) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: trimmed.slice(i, i + 1900) } }] },
      });
      if (blocks.length >= maxBlocks) return blocks;
    }
  }
  return blocks;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

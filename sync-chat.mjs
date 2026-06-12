// Importa mensagens do Google Chat (espacos e DMs da conta autenticada) para o Notion.
// Env: NOTION_TOKEN, CHAT_DATABASE_ID, LOOKBACK_DAYS (padrao 2)

import {
  getAccessToken, notionExistingIds, createNotionPage, paragraphs,
  pTitle, pText, pDate, pSelect, sleep,
} from "./google-common.mjs";

const DB = process.env.CHAT_DATABASE_ID;
const DAYS = parseInt(process.env.LOOKBACK_DAYS || "2", 10);

if (!process.env.NOTION_TOKEN || !DB) {
  console.error("ERRO: defina NOTION_TOKEN e CHAT_DATABASE_ID.");
  process.exit(1);
}

const { accessToken, tokens } = await getAccessToken();
const selfName = tokens.self_id ? `users/${tokens.self_id}` : null;

const CHAT_BASE = "https://chat.googleapis.com/v1/";

async function chat(path, params = {}) {
  const url = new URL(CHAT_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`Chat API (${path}): ${resp.status} ${await resp.text()}`);
  return resp.json();
}

const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
console.log(`Buscando mensagens desde ${since}...`);

const spaces = [];
let pageToken;
try {
  do {
    const d = await chat("spaces", { pageSize: 100, pageToken });
    spaces.push(...(d.spaces || []));
    pageToken = d.nextPageToken;
  } while (pageToken);
} catch (err) {
  console.error(`ERRO ao listar espacos: ${err.message}`);
  console.error("DICA: confira se o Chat app foi configurado no console do Google Cloud (aba Configuration do Chat API).");
  process.exit(1);
}
console.log(`Encontrados ${spaces.length} espaco(s)/conversa(s).`);

const existing = await notionExistingIds(DB, "ID Mensagem");

let importadas = 0;
let falhas = 0;
for (const space of spaces) {
  const espacoNome =
    space.displayName || (space.spaceType === "DIRECT_MESSAGE" ? "Mensagem direta" : space.name);
  let pt;
  try {
    do {
      const d = await chat(`${space.name}/messages`, {
        pageSize: 100,
        pageToken: pt,
        filter: `createTime > \"${since}\"`,
      });
      for (const m of d.messages || []) {
        if (!m.name || existing.has(m.name)) continue;
        const texto = m.text || "";
        const temAnexo = (m.attachment || []).length > 0;
        if (!texto && !temAnexo) continue;
        const props = {
          "Prévia": pTitle((texto || "(anexo)").replace(/\s+/g, " ").slice(0, 80)),
          "Espaço": pText(espacoNome),
          "Remetente": pText(m.sender?.displayName || m.sender?.name || ""),
          "Data/hora": pDate(m.createTime || null),
          "Conteúdo": pText(texto),
          "Tipo": pSelect(temAnexo ? "anexo" : "texto"),
          "Direção": pSelect(
            selfName && m.sender?.name ? (m.sender.name === selfName ? "Enviada" : "Recebida") : null
          ),
          "ID Mensagem": pText(m.name),
          "Thread": pText(m.thread?.name || ""),
        };
        const blocks = texto.length > 1900 ? paragraphs(texto) : [];
        if (await createNotionPage(DB, props, blocks)) importadas++;
        else falhas++;
        await sleep(350);
      }
      pt = d.nextPageToken;
    } while (pt);
  } catch (err) {
    console.error(`AVISO: pulei o espaco \"${espacoNome}\": ${err.message}`);
  }
}

console.log(`Concluido: ${importadas} mensagem(ns) importada(s), ${falhas} falha(s).`);
if (falhas > 0) process.exit(1);

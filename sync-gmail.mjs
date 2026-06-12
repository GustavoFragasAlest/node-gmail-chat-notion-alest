// Importa emails do Gmail (conta autenticada) para o database do Notion.
// Env: NOTION_TOKEN, GMAIL_DATABASE_ID, LOOKBACK_DAYS (padrao 2)

import {
  getAccessToken, notionExistingIds, createNotionPage, paragraphs,
  pTitle, pText, pDate, pSelect, pMulti, pNumber, pStatus, sleep,
} from "./google-common.mjs";

const DB = process.env.GMAIL_DATABASE_ID;
const DAYS = parseInt(process.env.LOOKBACK_DAYS || "2", 10);

if (!process.env.NOTION_TOKEN || !DB) {
  console.error("ERRO: defina NOTION_TOKEN e GMAIL_DATABASE_ID.");
  process.exit(1);
}

const { accessToken } = await getAccessToken();

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";

async function gmail(path, params = {}) {
  const url = new URL(GMAIL_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    console.error(`ERRO Gmail API (${path}): ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  return resp.json();
}

const header = (payload, name) =>
  (payload.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

function countAttachments(part) {
  let n = part?.filename ? 1 : 0;
  for (const p of part?.parts || []) n += countAttachments(p);
  return n;
}

function findBody(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts || []) {
    const r = findBody(p, mime);
    if (r) return r;
  }
  return null;
}

const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const stripHtml = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]{2,}/g, " ");

console.log(`Buscando emails dos ultimos ${DAYS} dia(s)...`);
const ids = [];
let pageToken;
do {
  const data = await gmail("messages", { q: `newer_than:${DAYS}d`, maxResults: 100, pageToken });
  ids.push(...(data.messages || []).map((m) => m.id));
  pageToken = data.nextPageToken;
} while (pageToken);
console.log(`Encontrados ${ids.length} email(s) no periodo.`);

const existing = await notionExistingIds(DB, "ID Gmail");
const novos = ids.filter((id) => !existing.has(id));
console.log(`${novos.length} novo(s) para importar.`);

let importados = 0;
let falhas = 0;
for (const id of novos) {
  const msg = await gmail(`messages/${id}`, { format: "full" });
  const payload = msg.payload || {};
  const labels = msg.labelIds || [];
  let corpo = null;
  const plain = findBody(payload, "text/plain");
  if (plain) corpo = b64(plain);
  if (!corpo) {
    const html = findBody(payload, "text/html");
    if (html) corpo = stripHtml(b64(html));
  }
  const props = {
    "Assunto": pTitle(header(payload, "Subject") || "(sem assunto)"),
    "De": pText(header(payload, "From")),
    "Para": pText(header(payload, "To")),
    "Data": pDate(msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null),
    "Direção": pSelect(labels.includes("SENT") ? "Enviado" : "Recebido"),
    "Prévia": pText(msg.snippet || ""),
    "Labels": pMulti(labels.filter((l) => l !== "UNREAD")),
    "Anexos": pNumber(countAttachments(payload)),
    "ID Gmail": pText(id),
    "Thread ID": pText(msg.threadId || ""),
    "Status": pStatus("Capturado"),
  };
  if (await createNotionPage(DB, props, paragraphs(corpo || "(sem corpo de texto)"))) {
    importados++;
    console.log(`OK: ${(header(payload, "Subject") || id).slice(0, 60)}`);
  } else {
    falhas++;
  }
  await sleep(350);
}

console.log(`Concluido: ${importados} email(s) importado(s), ${falhas} falha(s).`);
if (falhas > 0) process.exit(1);

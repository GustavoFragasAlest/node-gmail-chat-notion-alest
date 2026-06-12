// Receptor em tempo real: Pub/Sub push -> Notion
// Rotas: POST /gmail (topico gmail-notify) e POST /chat (topico chat-notify)
// Zero dependencias - Node 20+ (fetch nativo), mesmo estilo dos syncs do repo.
//
// Variaveis de ambiente necessarias (mesmos valores dos secrets do GitHub):
//   NOTION_TOKEN, GMAIL_DATABASE_ID, CHAT_DATABASE_ID, GOOGLE_CLIENT, GOOGLE_TOKENS
// Opcionais:
//   OWNER_EMAIL (default bernardo.chassot@alest.com.br) - para Direcao do Gmail
//   OWNER_CHAT_USER (default users/111969888296961230505) - para Direcao do Chat

import http from "node:http"

const PORT = process.env.PORT || 8080
const NOTION_TOKEN = process.env.NOTION_TOKEN
const GMAIL_DATABASE_ID = process.env.GMAIL_DATABASE_ID
const CHAT_DATABASE_ID = process.env.CHAT_DATABASE_ID
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "bernardo.chassot@alest.com.br").toLowerCase()
const OWNER_CHAT_USER = process.env.OWNER_CHAT_USER || "users/111969888296961230505"
const GOOGLE_CLIENT = JSON.parse(process.env.GOOGLE_CLIENT || "{}")
const GOOGLE_TOKENS = JSON.parse(process.env.GOOGLE_TOKENS || "{}")
const clientCfg = GOOGLE_CLIENT.installed || GOOGLE_CLIENT.web || GOOGLE_CLIENT

const NOTION_API = "https://api.notion.com/v1"
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
const CHAT_API = "https://chat.googleapis.com/v1"

// ---------- Google auth (renova access token com o refresh token) ----------
let cachedToken = null
let cachedTokenExp = 0

async function googleAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExp - 60_000) return cachedToken
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientCfg.client_id,
      client_secret: clientCfg.client_secret,
      refresh_token: GOOGLE_TOKENS.refresh_token,
      grant_type: "refresh_token",
    }),
  })
  if (!res.ok) throw new Error(`Falha ao renovar access token: ${res.status} ${await res.text()}`)
  const data = await res.json()
  cachedToken = data.access_token
  cachedTokenExp = Date.now() + (data.expires_in || 3600) * 1000
  return cachedToken
}

async function gfetch(url) {
  const token = await googleAccessToken()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
  return res.json()
}

// ---------- Notion ----------
async function notionFetch(path, body) {
  const res = await fetch(NOTION_API + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`)
  return res.json()
}

// Mesma deduplicacao dos syncs diarios: se o ID ja existe no DB, pula.
async function alreadyInNotion(databaseId, property, value) {
  const data = await notionFetch("/databases/" + databaseId + "/query", {
    page_size: 1,
    filter: { property, rich_text: { equals: value } },
  })
  return data.results.length > 0
}

const rt = (content) => [{ text: { content: String(content || "").slice(0, 1900) } }]

// ---------- GMAIL ----------
function header(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ""
}

function countAttachments(part) {
  if (!part) return 0
  let n = part.filename && part.body?.attachmentId ? 1 : 0
  for (const p of part.parts || []) n += countAttachments(p)
  return n
}

// Estrategia resiliente: a notificacao do Gmail so diz "tem coisa nova".
// Listamos as mensagens recentes e deduplicamos pelo ID Gmail no Notion.
// Assim nao dependemos de guardar historyId (Cloud Run pode reiniciar a qualquer momento).
async function processGmail() {
  const list = await gfetch(GMAIL_API + "/users/me/messages?maxResults=20&q=newer_than:1d")
  let created = 0
  for (const m of list.messages || []) {
    if (await alreadyInNotion(GMAIL_DATABASE_ID, "ID Gmail", m.id)) continue
    const msg = await gfetch(GMAIL_API + "/users/me/messages/" + m.id + "?format=full")
    const headers = msg.payload?.headers || []
    const from = header(headers, "From")
    const direcao = from.toLowerCase().includes(OWNER_EMAIL) ? "Enviado" : "Recebido"
    await notionFetch("/pages", {
      parent: { database_id: GMAIL_DATABASE_ID },
      properties: {
        "Assunto": { title: rt(header(headers, "Subject") || "(sem assunto)") },
        "De": { rich_text: rt(from) },
        "Para": { rich_text: rt(header(headers, "To")) },
        "Dire\u00e7\u00e3o": { select: { name: direcao } },
        "Data": { date: { start: new Date(Number(msg.internalDate)).toISOString() } },
        "Pr\u00e9via": { rich_text: rt(msg.snippet) },
        "Labels": { multi_select: (msg.labelIds || []).slice(0, 10).map((name) => ({ name })) },
        "Anexos": { number: countAttachments(msg.payload) },
        "Status": { status: { name: "Capturado" } },
        "ID Gmail": { rich_text: rt(m.id) },
        "Thread ID": { rich_text: rt(msg.threadId) },
      },
    })
    created++
  }
  return created
}

// ---------- GOOGLE CHAT ----------
// O evento (Workspace Events, includeResource=false) traz o nome do recurso;
// buscamos a mensagem completa na API do Chat e gravamos no Notion.
async function processChat(eventData) {
  const name = eventData?.message?.name
  if (!name) {
    console.log("Evento de chat sem message.name (ignorado):", JSON.stringify(eventData).slice(0, 300))
    return 0
  }
  if (await alreadyInNotion(CHAT_DATABASE_ID, "ID Mensagem", name)) return 0
  const msg = await gfetch(CHAT_API + "/" + name)
  const text = msg.text || msg.formattedText || ""
  const temAnexo = Array.isArray(msg.attachment) && msg.attachment.length > 0
  const sender = msg.sender?.name || ""
  const direcao = sender === OWNER_CHAT_USER ? "Enviada" : "Recebida"
  let espaco = "Mensagem direta"
  try {
    if (msg.space?.name) {
      const space = await gfetch(CHAT_API + "/" + msg.space.name)
      espaco = space.displayName || "Mensagem direta"
    }
  } catch { /* DMs nao tem displayName - mantem o padrao */ }
  await notionFetch("/pages", {
    parent: { database_id: CHAT_DATABASE_ID },
    properties: {
      "Pr\u00e9via": { title: rt(text ? text.slice(0, 80) : "(anexo)") },
      "Espa\u00e7o": { rich_text: rt(espaco) },
      "Remetente": { rich_text: rt(sender) },
      "Dire\u00e7\u00e3o": { select: { name: direcao } },
      "Tipo": { select: { name: temAnexo && !text ? "anexo" : "texto" } },
      "Data/hora": { date: { start: msg.createTime } },
      "Conte\u00fado": { rich_text: rt(text) },
      "ID Mensagem": { rich_text: rt(name) },
      "Thread": { rich_text: rt(msg.thread?.name) },
    },
  })
  return 1
}

// ---------- HTTP server (recebe o push do Pub/Sub) ----------
const server = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200)
    res.end("ok")
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  try {
    const envelope = JSON.parse(body || "{}")
    const dataStr = envelope.message?.data
      ? Buffer.from(envelope.message.data, "base64").toString("utf8")
      : "{}"
    let data = {}
    try { data = JSON.parse(dataStr) } catch { /* payload nao-JSON */ }

    let created = 0
    if (req.url.startsWith("/gmail")) created = await processGmail()
    else if (req.url.startsWith("/chat")) created = await processChat(data)
    else {
      res.writeHead(404)
      res.end()
      return
    }
    console.log(JSON.stringify({ rota: req.url, criadas: created }))
    res.writeHead(204)
    res.end()
  } catch (err) {
    // Fail loud: 500 faz o Pub/Sub reentregar com backoff (nada se perde em silencio)
    console.error("Erro ao processar push:", err.message)
    res.writeHead(500)
    res.end()
  }
})

server.listen(PORT, () => console.log(`Receptor ouvindo na porta ${PORT}`))

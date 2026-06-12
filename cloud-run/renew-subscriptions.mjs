// Renova as inscricoes de tempo real (rodar 1x por dia, ex: como passo extra
// do workflow diario do GitHub Actions - elas expiram em ate 7 dias).
//
// Env necessarias: GOOGLE_CLIENT, GOOGLE_TOKENS
// Opcionais: GCP_PROJECT (default alest-internal-demo-gcp)
//
// 1) Gmail: users.watch -> publica notificacoes no topico gmail-notify
// 2) Chat: subscription do Workspace Events -> topico chat-notify

const project = process.env.GCP_PROJECT || "alest-internal-demo-gcp"
const GOOGLE_CLIENT = JSON.parse(process.env.GOOGLE_CLIENT || "{}")
const GOOGLE_TOKENS = JSON.parse(process.env.GOOGLE_TOKENS || "{}")
const clientCfg = GOOGLE_CLIENT.installed || GOOGLE_CLIENT.web || GOOGLE_CLIENT

const EVENTS_API = "https://workspaceevents.googleapis.com/v1"

async function googleAccessToken() {
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
  return (await res.json()).access_token
}

async function main() {
  const token = await googleAccessToken()
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

  // ---- 1) Gmail watch (chamar de novo = renova por mais 7 dias) ----
  const watch = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ topicName: `projects/${project}/topics/gmail-notify` }),
  })
  if (!watch.ok) throw new Error(`Gmail watch falhou: ${watch.status} ${await watch.text()}`)
  console.log("Gmail watch OK:", JSON.stringify(await watch.json()))

  // ---- 2) Chat subscription (Workspace Events) ----
  const subBody = {
    targetResource: "//cloudidentity.googleapis.com/users/me",
    eventTypes: ["google.workspace.chat.message.v1.created"],
    notificationEndpoint: { pubsubTopic: `projects/${project}/topics/chat-notify` },
    payloadOptions: { includeResource: false },
    ttl: "604800s",
  }
  const create = await fetch(EVENTS_API + "/subscriptions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(subBody),
  })
  if (create.ok) {
    console.log("Chat subscription criada:", JSON.stringify(await create.json()))
    return
  }
  const errText = await create.text()
  if (create.status === 409) {
    // Ja existe -> renova o TTL da subscription existente
    const filter = encodeURIComponent(
      'event_types:"google.workspace.chat.message.v1.created" AND target_resource="//cloudidentity.googleapis.com/users/me"'
    )
    const list = await fetch(EVENTS_API + "/subscriptions?filter=" + filter, { headers: auth })
    if (!list.ok) throw new Error(`Listar subscriptions falhou: ${list.status} ${await list.text()}`)
    const subs = (await list.json()).subscriptions || []
    for (const s of subs) {
      const patch = await fetch(
        EVENTS_API + "/" + s.name + "?updateMask=ttl",
        { method: "PATCH", headers: auth, body: JSON.stringify({ ttl: "604800s" }) }
      )
      if (!patch.ok) throw new Error(`Renovar subscription falhou: ${patch.status} ${await patch.text()}`)
      console.log("Chat subscription renovada:", s.name)
    }
    return
  }
  throw new Error(`Chat subscription falhou: ${create.status} ${errText}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})

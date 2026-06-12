// Login OAuth do Google - rodar UMA vez com a conta do Bernardo.
// Uso:
//   1. Salve o JSON do OAuth client (tipo "App para computador") como google-client.json nesta pasta
//   2. npm run auth
//   3. Bernardo faz login no navegador (janela que abre sozinha)
// Gera: google-tokens.json (NUNCA commitar - ja esta no .gitignore)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const CLIENT_FILE = "google-client.json";
const TOKENS_FILE = "google-tokens.json";
const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

if (!existsSync(CLIENT_FILE)) {
  console.error(`ERRO: ${CLIENT_FILE} nao encontrado nesta pasta.`);
  console.error("Baixe o JSON do OAuth client (tipo Desktop) no Google Cloud e salve como google-client.json");
  process.exit(1);
}

const client = JSON.parse(readFileSync(CLIENT_FILE, "utf8")).installed;
if (!client) {
  console.error("ERRO: JSON invalido (esperava a chave 'installed'). O client precisa ser do tipo 'App para computador'.");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authUrl = new URL(client.auth_uri);
authUrl.search = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPES,
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end();
    return;
  }
  const code = url.searchParams.get("code");
  const gotState = url.searchParams.get("state");
  if (!code || gotState !== state) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>Erro no login. Feche e tente de novo.</h2>");
    console.error("ERRO: callback sem code ou state invalido.");
    process.exit(1);
  }
  try {
    const tokenResp = await fetch(client.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResp.ok) throw new Error(`token exchange ${tokenResp.status}: ${await tokenResp.text()}`);
    const tokens = await tokenResp.json();
    if (!tokens.refresh_token) throw new Error("resposta sem refresh_token (revogue o acesso antigo em myaccount.google.com/permissions e rode de novo)");

    const meResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = meResp.ok ? await meResp.json() : {};

    writeFileSync(
      TOKENS_FILE,
      JSON.stringify(
        {
          refresh_token: tokens.refresh_token,
          self_id: me.id || null,
          self_email: me.email || null,
          obtained_at: new Date().toISOString(),
        },
        null,
        2
      )
    );
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>Login concluido para ${me.email || "conta Google"}. Pode fechar esta janela.</h2>`);
    console.log(`OK: tokens salvos em ${TOKENS_FILE} (conta: ${me.email || "?"})`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>Erro ao trocar o codigo por tokens. Veja o terminal.</h2>");
    console.error(`ERRO: ${err.message}`);
    process.exit(1);
  }
  server.close();
  process.exit(0);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Abra esta URL no navegador (deve abrir sozinha):\n");
  console.log(authUrl.toString());
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", authUrl.toString()] : [authUrl.toString()];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
});

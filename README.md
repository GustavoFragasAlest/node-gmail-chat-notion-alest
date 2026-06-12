# node-gmail-chat-notion-alest

Sync diario de **emails do Gmail** e **mensagens do Google Chat** (conta do Bernardo) para o Notion, via GitHub Actions. Sem servidor, sem Cloud Run.

## Arquivos

- `auth.mjs` - login OAuth (UMA vez, com a conta do Bernardo). Gera `google-tokens.json`.
- `sync-gmail.mjs` - importa emails para o DB "Emails Gmail (Bernardo)".
- `sync-chat.mjs` - importa mensagens para o DB "Mensagens Google Chat (Bernardo)".
- `.github/workflows/google-sync.yml` - roda todo dia as 03:00 (Brasilia).

> Diferente do TwinMind, o refresh token do Google **NAO rotaciona**: os secrets sao configurados UMA vez e pronto. Nao existe GH_PAT nem persistencia de tokens aqui.

## Secrets (Settings -> Secrets and variables -> Actions)

| Secret | Conteudo |
|---|---|
| `GOOGLE_CLIENT` | conteudo do `google-client.json` (JSON do OAuth client tipo Desktop) |
| `GOOGLE_TOKENS` | conteudo do `google-tokens.json` (gerado pelo `npm run auth`) |
| `NOTION_TOKEN` | token da integracao do Notion (a mesma usada no TwinMind) |
| `GMAIL_DATABASE_ID` | ID do database de emails no Notion |
| `CHAT_DATABASE_ID` | ID do database de mensagens no Notion |

## Setup (uma vez)

1. Salvar o JSON do OAuth client como `google-client.json` na pasta do repo
2. `npm run auth` (Bernardo loga no navegador - janela anonima)
3. Setar os 5 secrets (`gh secret set ... < arquivo`)
4. Conectar a integracao do Notion aos 2 databases (menu ... -> Conexoes, em cada DB)
5. Rodar manualmente: Actions -> "Gmail e Chat para Notion Sync" -> Run workflow (lookback_days: 30 na primeira vez)

## Se der erro de token (raro)

O token do Google so morre se: Bernardo trocar a senha, alguem revogar o acesso manualmente, ou 6 meses sem uso.
Solucao: refazer `npm run auth` com o Bernardo e atualizar SOMENTE o secret `GOOGLE_TOKENS`.

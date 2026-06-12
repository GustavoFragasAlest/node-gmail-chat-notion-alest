# Fase 2 — Tempo real (Gmail + Chat → Notion)

Fluxo: Gmail/Chat → Pub/Sub (`gmail-notify` / `chat-notify`) → Cloud Run (`server.mjs`) → Notion.
Latência esperada: segundos. A deduplicação é a mesma dos syncs diários (ID Gmail / ID Mensagem),
então o cron diário continua existindo como rede de segurança sem risco de duplicar.

## Pré-requisitos (Bloco A — FEITO em 12/06/2026)
- APIs ativas: Pub/Sub, Cloud Run Admin, Workspace Events, Gmail, Chat
- Tópicos `gmail-notify` e `chat-notify` criados
- `gmail-api-push@system.gserviceaccount.com` Publisher no `gmail-notify`
- `chat-api-push@system.gserviceaccount.com` Publisher no `chat-notify`

## Bloco C — Deploy e ativação (passo a passo)

### C1. Levar os secrets do GitHub para o Secret Manager (uma vez)
Os valores de `GOOGLE_TOKENS` etc. só existem nos secrets do GitHub (não dá para lê-los de volta).
Criar um workflow manual que os copie para o Secret Manager exige autenticação no GCP:
1. Admin do projeto cria uma service account `github-deployer` com papéis
   `Secret Manager Admin` + `Cloud Run Admin` + `Service Account User`, gera uma chave JSON.
2. Salvar a chave como secret `GCP_SA_KEY` no repo.
3. Criar (pelo editor web do GitHub — o app não tem permissão de Workflows) um workflow manual
   que rode `google-github-actions/auth` + `gcloud secrets versions add` para:
   `NOTION_TOKEN`, `GMAIL_DATABASE_ID`, `CHAT_DATABASE_ID`, `GOOGLE_CLIENT`, `GOOGLE_TOKENS`.

### C2. Deploy do Cloud Run
```bash
gcloud run deploy notion-realtime-sync \
  --source cloud-run/ \
  --region us-central1 \
  --project alest-internal-demo-gcp \
  --no-allow-unauthenticated \
  --set-secrets NOTION_TOKEN=NOTION_TOKEN:latest,GMAIL_DATABASE_ID=GMAIL_DATABASE_ID:latest,CHAT_DATABASE_ID=CHAT_DATABASE_ID:latest,GOOGLE_CLIENT=GOOGLE_CLIENT:latest,GOOGLE_TOKENS=GOOGLE_TOKENS:latest
```

### C3. Assinaturas push (Pub/Sub → Cloud Run)
```bash
# service account que o Pub/Sub usa para chamar o Cloud Run
gcloud iam service-accounts create pubsub-pusher --project alest-internal-demo-gcp
gcloud run services add-iam-policy-binding notion-realtime-sync \
  --region us-central1 --project alest-internal-demo-gcp \
  --member serviceAccount:pubsub-pusher@alest-internal-demo-gcp.iam.gserviceaccount.com \
  --role roles/run.invoker

SERVICE_URL=$(gcloud run services describe notion-realtime-sync --region us-central1 --project alest-internal-demo-gcp --format 'value(status.url)')

gcloud pubsub subscriptions create gmail-notify-push --topic gmail-notify \
  --project alest-internal-demo-gcp \
  --push-endpoint "$SERVICE_URL/gmail" \
  --push-auth-service-account pubsub-pusher@alest-internal-demo-gcp.iam.gserviceaccount.com

gcloud pubsub subscriptions create chat-notify-push --topic chat-notify \
  --project alest-internal-demo-gcp \
  --push-endpoint "$SERVICE_URL/chat" \
  --push-auth-service-account pubsub-pusher@alest-internal-demo-gcp.iam.gserviceaccount.com
```

### C4. Ativar e manter as inscrições
Rodar `node cloud-run/renew-subscriptions.mjs` com `GOOGLE_CLIENT` e `GOOGLE_TOKENS` no ambiente.
Recomendado: adicionar como passo extra do workflow diário (ele renova Gmail watch + Chat subscription).
Atenção: o formato exato do `targetResource`/TTL da subscription de Chat deve ser validado nos docs
(https://developers.google.com/workspace/events/guides/events-chat) na ativação.

### C5. Teste fim a fim
1. Mandar uma mensagem de Chat para o Bernardo → deve aparecer no DB em segundos.
2. Enviar um email para o Bernardo → idem.
3. Conferir logs do Cloud Run em caso de falha (`rota`/`criadas` em cada push).

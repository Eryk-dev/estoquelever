# Runbook — Bateria Automática de Estoque

## O que é
Suíte de cenários ponta-a-ponta + 8 invariantes globais (I1–I8) que valida todo
fluxo que toca o ledger. Roda toda noite (03:00 BRT) via GitHub Actions contra
staging e alerta no Slack/Discord quando algum fluxo de estoque quebra.

## GitHub Secrets necessários (Settings → Secrets and variables → Actions)
| Secret | Valor |
|---|---|
| `STAGING_SUPABASE_URL` | `https://ehbxpbeijofxtsbezwxd.supabase.co` |
| `STAGING_SUPABASE_ANON_KEY` | anon key do projeto staging |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | service role key do staging |
| `STAGING_WORKER_SECRET` | mesmo `WORKER_SECRET` do Vercel staging |
| `STOCK_SUITE_WEBHOOK_URL` | incoming webhook do Slack ou Discord |

> ⚠️ O cron `schedule:` do GitHub Actions só dispara a partir da **branch
> default** do repositório. Pra a bateria rodar automaticamente toda noite, o
> workflow `.github/workflows/wms-stock-suite.yml` precisa estar mergeado na
> branch default (hoje: confira em Settings → Branches). Em branch de feature, só
> o `workflow_dispatch` (run manual) funciona.

## Rodar local (precisa de `.env.test.local`)
Crie `.env.test.local` na raiz com as chaves REAIS de staging (sobrescreve os
placeholders de `.env.test`):
```
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key staging>
SUPABASE_SERVICE_ROLE_KEY=<service role key staging>
```
Depois:
- Modo prod (igual ao CI, build + next start): `npm run scenarios:ci`
- Debug rápido (modo dev, 1 cenário): `npm run scenarios:only -- "49b"`
- Filtrar por tag: `npm run scenarios -- --filter p3`
- Teste de integração das RPCs (inclui I8): `npm run test:integration`
- Forçar heartbeat verde no Slack: `STOCK_SUITE_WEBHOOK_URL=<url> npm run notify:stock -- --always`

## Rodar na mão no GitHub
Actions → "WMS Stock Ledger Suite" → Run workflow.

## Ler o resultado
- Artifact `stock-suite-report` (md + json) no run do Actions.
- Classes de falha:
  - 🔴 **product-fail** = bug de estoque (assert/invariante/erro de negócio) → job vermelho + alerta.
  - 🟡 **infra-fail** = run inconclusiva (servidor caiu/instável após retries) → NÃO derruba o build, sinalizado à parte.
  - 🟢 verde = todos os fluxos OK.
- O alerta lista os fluxos quebrados + o invariante violado.

## Invariantes (o que cada um pega)
- **I1** saldo cache = Σ(E)−Σ(S) por posição (ledger↔cache).
- **I8** reservado cache = GREATEST(0, Σ(R)−Σ(L)) por posição (fecha o ponto-cego do I1).
- **I2** disponivel = saldo − reservado em toda linha.
- **I3** custo médio = fold ponderado das entradas custeadas (whitelist de 5 origens).
- **I4** sem reservas órfãs (toda R expirada tem L).
- **I5** pendências de guarda coerentes.
- **I6** pares S+E balanceados (transferência/realocação).
- **I7** fila de execução vazia em repouso.

## ⚠️ Cuidados
- A suíte TRUNCA tabelas operacionais de staging a cada run (catálogo é
  preservado). Não rodar enquanto alguém usa staging manualmente — por isso o
  cron é 03:00 BRT.
- `validarStaging()` aborta se a URL não for o projeto staging — a run destrutiva
  nunca toca prod.

## Rollback / pausar
- Pausar o cron: comentar o bloco `schedule:` no workflow (mantém o
  `workflow_dispatch` pra rodar na mão).

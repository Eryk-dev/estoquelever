# WMS Staging Playground — Design

**Data:** 2026-05-11
**Status:** Spec aprovado — pronto pra plano de implementação
**Relacionado:** [`2026-05-07-wms-design.md`](2026-05-07-wms-design.md) (spec geral do WMS), [`../plans/wms-staging-policy.md`](../plans/wms-staging-policy.md) (estado do staging em 2026-05-08), [`../plans/2026-06-12-wms-6-go-live.md`](../plans/2026-06-12-wms-6-go-live.md) (cutover futuro — fora do escopo aqui)

---

## 1. Problema

A branch `develop` tem o módulo WMS implementado (7 migrations, ~30 telas, lógica completa de ledger/movimentações/inventário/devoluções) e já deploya automaticamente na Vercel. Mas o ambiente **não é testável na prática**:

- O Supabase de staging dedicado (`ehbxpbeijofxtsbezwxd`) tem só bootstrap mínimo (CWB, SP, NetAir, NetParts, user Eryk) — sem produtos, sem pedidos, sem histórico
- Resultado: as telas `/wms/*` abrem mas estão vazias. Não dá pra simular um cenário real (receber 50 unidades de SKU X, transferir, inventariar, etc.)
- O user perdeu confiança no ambiente e não consegue validar nada antes de pensar em cutover pra produção

A prod (`wrbrbhuhsaaupqsimkqz`, servida pela branch `main` em siso.netair.com.br) é crítica pra operação e **não pode ser tocada**.

## 2. Objetivo

Construir um pipeline que mantém o Supabase de staging **espelhado** com os dados de prod, de forma que:

1. Todas as tabelas SISO/Cross relevantes em staging sejam cópias frescas de prod
2. As tabelas WMS (que só existem em staging) sejam populadas inicialmente via `snapshot-inicial` (lê estoque do Tiny e grava no ledger)
3. Staging fique isolado de prod via desativação de credenciais Tiny — não há caminho pelo qual uma ação em staging mexa em prod
4. O refresh seja triggerável manualmente via script local (Fase 1) e depois automatizável via CI (Fase 2, fora do escopo deste spec)

**Não está no escopo deste spec:**

- ❌ Cutover do WMS em staging (substituir Tiny como fonte da verdade no fluxo de pedidos). Isso é o Plano 6, separado.
- ❌ Cutover em prod. Continuamos longe disso.
- ❌ Automação CI (GitHub Actions). Fase 2, depois de o playground estar validado.
- ❌ Feature flag `WMS_ENABLED` em código. Não precisa pro playground — o WMS já existe como módulo isolado.

## 3. Arquitetura

### 3.1 Dois ambientes, mesmo código

| | Prod | Staging |
|---|---|---|
| Branch | `main` | `develop` |
| URL Vercel | siso.netair.com.br | `<deploy-preview>.vercel.app` |
| Supabase | `wrbrbhuhsaaupqsimkqz` | `ehbxpbeijofxtsbezwxd` |
| Tiny ERP | tokens ativos, recebe webhook | tokens desativados após refresh |
| Tabelas WMS | não existem | existem (7 migrations aplicadas) |
| Webhook Tiny | aponta pra prod | não aponta pra staging |

Código é exatamente o mesmo dos dois lados. Diferença está nas **env vars na Vercel** (escopadas por branch/zona): `develop` Preview → staging; `main` Production → prod.

### 3.2 Dois "mundos" em staging

Staging compartilha mesmo banco mas hospeda dois fluxos que **não conversam entre si**:

**Mundo 1 — SISO legado (snapshot de prod)**
- Telas: `/siso`, `/separacao`, `/compras`, `/pedidos`, `/painel`, etc.
- Dados copiados de prod (pedidos reais, histórico, etc.)
- Tiny tokens desativados → ações que chamariam Tiny (aprovar pedido, imprimir etiqueta) falham de forma controlada
- Útil pra ver dados reais e fazer leitura, **não pra clicar em ações que escrevem no Tiny**

**Mundo 2 — WMS sandbox**
- Telas: `/wms/produtos`, `/wms/estoque`, `/wms/ledger`, `/wms/receber`, `/wms/transferir`, `/wms/inventario`, etc.
- Independente do fluxo de pedidos
- Saldos populados via `snapshot-inicial` (lê Tiny, grava em `siso_estoque`)
- User opera manualmente: recebe, transfere, ajusta, inventariar — tudo registrado no ledger imutável

Os dois mundos compartilham as tabelas auxiliares (`siso_empresas`, `siso_galpoes`, `siso_usuarios`, `siso_produtos_catalogo`, etc.) mas não há código que conecte ações de um ao outro. O Plano 6 (cutover) é o que vai construir essa ponte.

### 3.3 Fluxo do refresh

```
                            ┌──────────────────────────────┐
                            │  scripts/staging-refresh.ts   │
                            └──────────────┬───────────────┘
                                           │
            ┌──────────────────────────────┴──────────────────────────────┐
            ▼                                                             ▼
     ┌──────────────┐                                              ┌──────────────┐
     │ PROD Supabase│  ───── 1. pg_dump (read-only, tabelas) ────▶ │  /tmp/*.dump │
     │ wrbrbhuhsaa..│                                              └──────┬───────┘
     └──────────────┘                                                     │
                                                                          ▼
                                                                  ┌──────────────┐
                                                                  │STAGING Supabase│
                                                                  │ ehbxpbeijo.. │
                                                                  └──────┬───────┘
                                                                         │
        2. pg_restore --clean (sobrescreve siso_* listadas)              │
        3. snapshot-inicial (lê Tiny prod, popula siso_estoque) ─────────┤
        4. Sanitização SQL (desativa tokens Tiny, limpa sessões) ────────┘
```

Ordem é deliberada: o passo 3 (snapshot-inicial) precisa dos tokens Tiny **válidos** vindos do dump, então a sanitização (passo 4) só roda depois.

## 4. Componentes

### 4.1 `scripts/staging-refresh.ts`

Script TypeScript executado via `tsx`. Estrutura (pseudo-código ilustrativo — detalhes de impl ficam no plano):

```ts
// Sanity check
assert(PROD_DB_URL.includes('wrbrbhuhsaaupqsimkqz'), 'PROD_DB_URL inválida')
assert(STAGING_DB_URL.includes('ehbxpbeijofxtsbezwxd'), 'STAGING_DB_URL inválida')
assert(PROD_DB_URL !== STAGING_DB_URL, 'URLs idênticas — abortar')

// 1. Dump
spawnSync('pg_dump', [
  '--format=custom', '--no-owner', '--no-privileges',
  '--table=public.siso_galpoes',
  '--table=public.siso_empresas',
  // ... (lista completa abaixo)
  PROD_DB_URL
], { stdio: ['ignore', dumpFile, 'inherit'] })

// 2. Restore
spawnSync('pg_restore', [
  '--clean', '--if-exists', '--no-owner', '--no-privileges',
  '--dbname', STAGING_DB_URL,
  dumpFile
])

// 3. Snapshot-inicial (HTTP call no deploy de staging)
await fetch(`${STAGING_APP_URL}/api/wms/snapshot-inicial`, {
  method: 'POST',
  headers: { 'x-worker-secret': STAGING_WORKER_SECRET }
})

// 4. Sanitização
await execSql(STAGING_DB_URL, `
  UPDATE siso_tiny_connections SET
    access_token = 'STAGING_DISABLED',
    refresh_token = 'STAGING_DISABLED',
    ativo = false;
  DELETE FROM siso_sessoes;
  INSERT INTO siso_configuracoes (chave, valor)
    VALUES ('ambiente', 'staging')
    ON CONFLICT (chave) DO UPDATE SET valor = 'staging';
`)

// 5. Cleanup
fs.unlinkSync(dumpFile)
```

Flags suportadas:
- `--dry-run`: mostra o que vai fazer sem executar destrutivos
- `--skip-restore`: pula passos 1-2 (re-roda só snapshot-inicial + sanitização)
- `--only-snapshot-inicial`: roda só o passo 3
- `--keep-dump`: não deleta o arquivo `/tmp/*.dump` no final (debug)

### 4.2 Tabelas no dump

**Incluir (cópia integral):**
- Hierarquia: `siso_galpoes`, `siso_empresas`, `siso_grupos`, `siso_grupo_empresas`
- Pessoas: `siso_usuarios`
- Pedidos: `siso_pedidos`, `siso_pedido_itens`, `siso_pedido_item_estoques`, `siso_pedido_historico`
- Compras: `siso_ordens_compra` (+ tabelas filhas se existirem)
- Inventário (legado): `siso_inventarios`, `siso_inventario_itens`
- Transferências (legado): `siso_transferencias`, `siso_transferencia_itens`
- Cross: `siso_produtos_catalogo`, `siso_produto_oems`, `siso_produto_veiculos`
- Infra: `siso_tiny_connections`, `siso_configuracoes`

**Incluir (com filtro de tempo):**
- `siso_webhook_logs` — últimos 7 dias (via `--where "criado_em > now() - interval '7 days'"`)

**Pular intencionalmente:**
- `siso_logs`, `siso_erros`, `siso_api_calls`, `siso_cross_logs` — volumosas, sem valor pra teste
- `siso_sessoes` — sessões expiram, melhor pedir login novo
- Tabelas WMS (`siso_produtos`, `siso_estoque`, `siso_movimentacoes`, `siso_localizacoes`, `siso_produto_empresas`, `siso_fornecedores`, `siso_produto_fornecedores`, `siso_emprestimo_regras`, `siso_localizacao_locks`, `siso_inventario_sessoes`, `siso_inventario_areas`, `siso_inventario_localizacoes`, `siso_inventario_contagens`, `siso_inventario_divergencias`, `siso_devolucoes_pendentes`) — não existem em prod; ficam intocadas em staging

### 4.3 `scripts/staging-sanity-check.ts`

Verificações rápidas (sem alterar nada):
- Conta migrations WMS aplicadas em staging (deve ser 7)
- Conta linhas das tabelas principais (`siso_pedidos`, `siso_produtos_catalogo`, `siso_estoque`)
- Verifica que `siso_tiny_connections` tem `ativo = false` em todas (ou tokens `STAGING_DISABLED`)
- Verifica que `siso_configuracoes` tem chave `ambiente = 'staging'`
- Saída: tabela formatada ✅/❌

### 4.4 Variáveis de ambiente (locais, só pro script)

```
PROD_DB_URL=postgresql://...@db.wrbrbhuhsaaupqsimkqz.supabase.co:5432/postgres
STAGING_DB_URL=postgresql://...@db.ehbxpbeijofxtsbezwxd.supabase.co:5432/postgres
STAGING_APP_URL=https://<deploy-de-develop>.vercel.app
STAGING_WORKER_SECRET=<o secret que está na Vercel pra develop>
```

Pegar connection strings em Supabase Dashboard → Settings → Database → URI mode (sem connection pooling).

Adicionar essas linhas no arquivo `.env` (ou `.env.local`, conforme convenção do projeto — ambos git-ignored). Não commitar.

### 4.5 Comandos no `package.json`

```json
{
  "scripts": {
    "staging:refresh": "tsx scripts/staging-refresh.ts",
    "staging:refresh:dry-run": "tsx scripts/staging-refresh.ts --dry-run",
    "staging:sanity-check": "tsx scripts/staging-sanity-check.ts"
  }
}
```

## 5. Salvaguardas (defesa em camadas)

1. **Sanity check no início do script** aborta se as connection strings estiverem invertidas ou idênticas
2. **Toda conexão "de escrita" do script aponta pra staging.** Prod só recebe `pg_dump` (read-only por definição)
3. **Vercel env vars são escopadas por ambiente** — Preview (develop) vs Production (main) são listas separadas no painel. User já confirmou estarem corretas
4. **Tiny tokens desativados em staging após cada refresh** — ações que chamariam Tiny falham com erro controlado, não impactam prod
5. **Sem webhook do Tiny apontando pra staging** — não há tráfego automático entrando em staging
6. **Dump file em `/tmp` é deletado** ao fim do script (a menos que rode com `--keep-dump`)

### Riscos residuais

- **Dado real em `/tmp` durante a execução do script** — CNPJs, nomes, etc. de prod ficam no disco local por alguns minutos. Mitigação: script faz `rm` no final; user pode rodar em máquina pessoal de confiança
- **Tiny API consome cota** durante o `snapshot-inicial` (~3-5k chamadas read-only). Não altera nada em prod, mas usa rate-limit por ~5min
- **Se o user clicar em "Aprovar" num pedido em staging**, a chamada Tiny falha (token desabilitado). Não muda prod, mas pode confundir o user na primeira vez. Mitigação: a sanitização adiciona uma marca `ambiente=staging` em `siso_configuracoes` que pode ser usada no futuro pra mostrar badge "STAGING" no header

## 6. Operação no dia a dia

### Primeira execução

1. Preencher `.env.local` com as 4 variáveis novas
2. Verificar que migrations WMS estão aplicadas em staging:
   ```bash
   npm run staging:sanity-check
   ```
3. Backup manual do staging atual (paranoia, primeira vez):
   ```bash
   pg_dump --format=custom "$STAGING_DB_URL" > /tmp/staging-pre-refresh-backup.dump
   ```
4. Dry-run pra ver o que vai acontecer:
   ```bash
   npm run staging:refresh:dry-run
   ```
5. Refresh real:
   ```bash
   npm run staging:refresh
   ```
6. Abrir o deploy de develop, logar com `Eryk / 1234`, abrir `/wms/estoque` — deve mostrar produtos e saldos reais
7. Confirmar sanity:
   ```bash
   npm run staging:sanity-check
   ```

### Execuções subsequentes

Sempre que quiser dados frescos (provavelmente 1× por semana):

```bash
npm run staging:refresh
```

Tempo esperado: 5-10 min (dump + restore + snapshot-inicial).

### Troubleshooting

| Sintoma | Provável causa | Ação |
|---|---|---|
| Script para no sanity check | URL trocada ou idêntica | Conferir `.env.local` |
| `pg_restore` falha "permission denied" | Service-role key errada | Conferir Settings → Database → Connection String em Supabase Dashboard |
| `snapshot-inicial` retorna 401 | `STAGING_WORKER_SECRET` errado | Conferir env vars na Vercel + `.env.local` |
| `snapshot-inicial` retorna 500 com erro Tiny | Tokens Tiny no dump não funcionam | Rodar refresh full de novo (talvez tokens expiraram) |
| `/wms/estoque` aparece vazio após refresh | Vercel env vars de develop apontando pra prod (sem WMS) | Conferir Vercel → Project Settings → Env Variables → Preview |
| `/wms/estoque` aparece vazio mas snapshot OK | snapshot-inicial pulou o passo do Tiny | Rodar `npm run staging:refresh -- --only-snapshot-inicial` |

## 7. Out of scope (Phase 2 e além)

### Fase 2 — Automação CI

Quando o playground estiver validado em uso real (~1-2 semanas):

- `.github/workflows/staging-refresh.yml` com cron diário (sugestão: 04h horário Brasília, antes do horário comercial)
- Secrets no GitHub: `PROD_DB_URL`, `STAGING_DB_URL`, `STAGING_APP_URL`, `STAGING_WORKER_SECRET`
- Workflow pode ser triggerado manualmente também ("Run workflow" no GitHub UI)
- Notificação simples: falha → abre issue automaticamente no repo
- Mesmo script (`staging-refresh.ts`), só muda quem chama

Spec separado quando for fazer.

### Plano 6 — Cutover em staging

Substituir Tiny como fonte da verdade no fluxo de pedidos **dentro de staging**, mantendo prod intocada. Já tem plano escrito ([`2026-06-12-wms-6-go-live.md`](../plans/2026-06-12-wms-6-go-live.md)) mas com escopo de cutover em prod. Vai precisar adaptar pra cutover em staging — feature flag `WMS_ENABLED`, caminho alternativo em `webhook-processor.ts` e `execution-worker.ts`, novos testes E2E.

Trabalho separado, depois deste spec.

### Plano 7 — Cutover em prod

Big bang em prod conforme o plano original. Só depois de o cutover em staging estar estável.

## 8. Critério de sucesso

Este spec é considerado entregue quando:

1. ✅ `npm run staging:refresh` roda do início ao fim sem erro, em <15 min
2. ✅ `npm run staging:sanity-check` retorna tudo verde após refresh
3. ✅ Logando em staging com `Eryk / 1234`:
   - `/siso` mostra pedidos reais (não vazio)
   - `/wms/produtos` mostra catálogo populado
   - `/wms/estoque` mostra saldos com valores > 0 em pelo menos 100 SKUs
   - `/wms/ledger` mostra ao menos as movimentações criadas pelo snapshot-inicial
4. ✅ Tentar "Aprovar" um pedido em staging falha com erro Tiny (não muda nada em prod) — verificável conferindo logs no painel Tiny prod (zero chamadas vindas do IP da Vercel develop)
5. ✅ Você consegue fazer um cenário completo manualmente em staging:
   - Receber 50 unidades de SKU X (mov tipo E no ledger)
   - Transferir 10 unidades pra outro galpão (par S+E)
   - Ajustar -2 unidades com motivo (mov tipo S)
   - Conferir saldo final em `/wms/estoque` (38 no galpão origem, 10 no destino)
6. ✅ Documentação operacional (passos 1-7 da seção 6) é seguível por outra pessoa sem precisar perguntar nada

## 9. Decisões registradas

- **Estratégia de refresh:** manual local (Phase 1), automatizar via CI depois (Phase 2)
- **Frequência alvo:** semanal ou on-demand (não diário ainda — sem urgência)
- **Tokens Tiny em staging:** desabilitados após cada refresh
- **Webhook do Tiny pra staging:** não, intencionalmente
- **Escopo do playground:** apenas dados + telas WMS manuais. Sem cutover.
- **Vercel env vars:** já configuradas pelo user em Preview (develop) → staging Supabase

---

**Próximo passo:** plano de implementação task-by-task (skill `writing-plans`).

# Staging WMS — Política operacional (executada)

## Contexto

A Fase 0 do WMS foi implementada e validada num ambiente Supabase **isolado de prod**.
Tudo neste documento reflete o que foi efetivamente executado em 2026-05-08.

## Por que não usamos branch Supabase

A branch original (`wms-fase0` em `wrbrbhuhsaaupqsimkqz`) falhou na replay automática
de migrations históricas: o projeto SISO compartilha banco com várias outras apps
(Lever, MercadoLivre conciliador, Cross), totalizando 270+ migrations das quais
algumas legadas não são mais replayáveis do zero. Branch ficou em `MIGRATIONS_FAILED`
e foi deletada.

## Solução adotada

Usamos um **projeto Supabase separado** como staging:
- **Project ID:** `ehbxpbeijofxtsbezwxd` (nome interno: 100M)
- **URL:** `https://ehbxpbeijofxtsbezwxd.supabase.co`

Bootstrap mínimo aplicado lá (`siso_galpoes`, `siso_empresas`, `siso_usuarios`)
copiando os UUIDs reais de prod (CWB, SP, NetAir, NetParts, user Eryk/1234/admin).

Por cima disso aplicamos **2 migrations WMS**:
1. `20260508_wms_foundation` — schema 4D + ledger + RPC com lock
2. `20260508_wms_reconciliacao_rpc` — funções de reconciliação ledger↔estoque

Ambas existem em `supabase/migrations/` e são portáveis pra prod (idempotentes,
puramente aditivas, sem destruição de dados existentes).

## Validações realizadas

- ✅ `npm run build` compila sem erros (todas as rotas `/wms/*` e `/api/wms/*` listadas)
- ✅ `npm test` passa (9 testes — 1 smoke + 8 ledger)
- ✅ CHECK constraint da tabela `siso_movimentacoes` rejeita mov inválida (saldo_posterior incoerente com tipo)
- ✅ Pipeline end-to-end: produto criado → mapeamento Tiny → mov via RPC → cache atualizado
- ✅ Fluxo R+L: reserva 30 + libera 10 → estado final saldo=100, reservado=20, disponivel=80 (computed column)
- ✅ Reconciliação retorna 0 divergências após chain consistente

## Como rodar localmente contra staging

`.env.local` ainda **não existe** no projeto (usuário pode usar `.env.staging`
ou substituir as vars conforme conveniência):

```
NEXT_PUBLIC_SUPABASE_URL=https://ehbxpbeijofxtsbezwxd.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<copiar publishable_key da dashboard>
SUPABASE_SERVICE_ROLE_KEY=<copiar service_role da dashboard, NUNCA commitar>
WORKER_SECRET=<gerar valor novo só pra staging>
```

A `service_role_key` precisa ser copiada manualmente da dashboard:
https://supabase.com/dashboard/project/ehbxpbeijofxtsbezwxd/settings/api

Login no app de staging usa `Eryk / 1234 / admin` (mesmo PIN de prod, escopo isolado).

## O que NÃO foi feito (intencionalmente)

- ❌ Vercel preview env vars (manual no painel da Vercel — pulou conforme decisão do user)
- ❌ Cópia completa de usuários de prod (só Eryk foi copiado)
- ❌ Badge visual "STAGING" no header (foco em backend + smoke da migration)
- ❌ Snapshot inicial executado em produção (existe endpoint `/api/wms/snapshot-inicial`, dry-run validado, execução real fica pra Fase 1)

## Próximos passos (Plano 2+)

A migration `20260508_wms_foundation.sql` está pronta pra ser aplicada em prod.
Antes de promover:
1. Validar visualmente as 4 telas WMS rodando localmente contra staging
2. Decidir se mantém esse projeto staging dedicado ou volta a usar branches do SISO
3. Aplicar a migration em prod (puramente aditiva, baixo risco)
4. Iniciar Plano 2 (movimentações operacionais — recebimento, transferências, picking)

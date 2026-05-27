# Backfill R1 — execução em staging

**Data:** 2026-05-27
**Project:** ehbxpbeijofxtsbezwxd (staging)
**Branch:** develop (sem worktree, conforme instrução do user)

## Baselines pré-fix-final (T1)

Coletados via `mcp__supabase__execute_sql` no projeto staging em 2026-05-27 14:07 BRT.

- **Divergências (`wms_detectar_divergencias_estoque()`)**: 0 rows ✅
- **Movs com `nota_fiscal_id IS NULL`** quando `origem_tipo IN ('nf_compra','nf_venda','devolucao_cliente_integra','devolucao_cliente_avariada','devolucao_fornecedor_recebida','devolucao_fornecedor_enviada')`: **1 / 1 = 100%** (confirma necessidade de R5)
- **OCs com `status='recebida'` sem mov `nf_compra`**: 0 (staging tem 0 OCs totais — base limpa pós-truncate)
- **Tabela `siso_notas_fiscais`** existe: **false** (confirma necessidade da migration T5)

### Suite de cenários

- Catálogo atual tem **34 cenários** (`scripts/wms/cenarios/catalogo/`), não 25 como o plano original assumiu.
- Plan-mismatch: cenários 26-32 já existem; renumerados pra **34-40** durante execução do Fix-Final A (escolha do user em 2026-05-27).
- Status anterior: cenário 01 falhou com `assert` (não-determinismo do nf-webhook + cutover). Suite suspensa durante baseline pra economizar tempo — será re-rodada em T31 (verificação final §5) com o gating split corrigido em T13.

## Plano de execução
- Skip do worktree (Task 2 do plano original): user pediu trabalhar direto em `develop`.
- Skip do PR (Task 32 ajustada): user pediu direto em `develop`, sem fluxo de revisão externa.

## Smoke A7 (T10)

T10 do plano original prescreve rodar cenários 01 / 10 / 11 e checar via SQL que movs novas têm `nota_fiscal_id`. **Adiado pra T31 (verificação final)** pra não pagar 2× o custo da suite (cada run leva ~5min+ e tem flakiness em FK). A SQL de verificação fica documentada aqui:

```sql
-- Toda mov nova de NF deve ter nota_fiscal_id populado:
SELECT origem_tipo, COUNT(*) AS total, COUNT(*) FILTER (WHERE nota_fiscal_id IS NULL) AS sem_fk
FROM siso_movimentacoes
WHERE origem_tipo IN ('nf_compra','nf_venda','devolucao_cliente_integra','devolucao_cliente_avariada','devolucao_fornecedor_recebida','devolucao_fornecedor_enviada')
  AND criado_em > '2026-05-27 17:00:00+00'  -- após aplicação da migration T5
GROUP BY origem_tipo;
```

Espera-se `sem_fk = 0` em todas as linhas pós-T7/T8 (cutover do worker WMS).

## Backfill R1 (T27/T28)

- Snapshot pré: divergências = 0
- Dry-run (`npx tsx scripts/wms/backfill-compras-recebidas.ts --dry`):
  ```
  Items com compra_quantidade_recebida > 0: 0
  Movs a criar: 0
  ```
- Apply: skip — sem candidatas em staging. Em prod o script roda pós-promoção quando houver volume real.
- Snapshot pós: divergências = 0 (sem mudança esperada)

## Backfill NF (T9)

- Dry-run: 1 mov candidata, 1 skipped_sem_chave (origem_detalhes sem `chave_acesso`)
- Apply: created=0, linked=0, skipped_sem_chave=1, erros=0 → no-op em staging (esperado: staging foi truncado várias vezes)
- Em prod, o mesmo script será re-executado pós-promoção quando houver volume real de NFs históricas.

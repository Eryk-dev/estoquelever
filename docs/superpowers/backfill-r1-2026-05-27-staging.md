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

## Backfill NF (T9)

- Dry-run: 1 mov candidata, 1 skipped_sem_chave (origem_detalhes sem `chave_acesso`)
- Apply: created=0, linked=0, skipped_sem_chave=1, erros=0 → no-op em staging (esperado: staging foi truncado várias vezes)
- Em prod, o mesmo script será re-executado pós-promoção quando houver volume real de NFs históricas.

-- P055 — no máximo 1 sessão de inventário por (galpão, dia), excluindo as
-- canceladas e a sessão operacional contínua (que já tem uniq_sessao_continua_galpao).
-- Data = criado_em (programada_para nunca é setado pelo fluxo atual).
--
-- criado_em é timestamptz: o cast direto ::date é STABLE (depende do TimeZone da sessão),
-- e Postgres rejeita expressões não-IMMUTABLE em índice. (criado_em AT TIME ZONE 'UTC')::date
-- é IMMUTABLE e equivale ao dia-calendário (o banco roda em UTC).
--
-- NOTA (prod populada): em prod com volume, construir o índice CONCURRENTLY,
-- FORA do BEGIN/COMMIT (CREATE UNIQUE INDEX CONCURRENTLY não roda em transação).
-- Inline (dentro do BEGIN) é aceitável só pra staging, que está vazio.

BEGIN;

CREATE UNIQUE INDEX uq_inv_sessao_galpao_dia
  ON siso_inventario_sessoes (galpao_id, ((criado_em AT TIME ZONE 'UTC')::date))
  WHERE status <> 'cancelada' AND continua = false;

COMMENT ON INDEX uq_inv_sessao_galpao_dia IS
  'P055: 1 sessão de inventário (não-contínua, não-cancelada) por galpão por dia.';

COMMIT;

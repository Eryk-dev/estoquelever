-- P052 — Lease de classificação de devolução (claim atômico anti-race).
--
-- classificarDevolucao tinha guard TOCTOU: lia status (aguardando_classificacao),
-- emitia N movs, e só no fim setava status='classificada'. Duas chamadas
-- concorrentes ambas passavam o read-check e duplicavam movs.
--
-- A CHECK de status (IN aguardando_classificacao/classificada/cancelada)
-- proíbe um estado intermediário 'classificando'. Em vez de relaxar a CHECK
-- (backstop de banco), adicionamos uma coluna de lease claimada via UPDATE
-- condicional — mesmo padrão de recebimento_em_andamento_por (transferência) e
-- iniciada_por (guarda). É a base reusável pela RPC wms_classificar_devolucao
-- (fase 4), onde o claim vira o primeiro statement da transação.

ALTER TABLE siso_devolucoes_pendentes
  ADD COLUMN IF NOT EXISTS classificacao_em_andamento_por uuid;

COMMENT ON COLUMN siso_devolucoes_pendentes.classificacao_em_andamento_por IS
  'P052 — Lease anti-race em classificarDevolucao. Claimado via UPDATE '
  'condicional (WHERE status=aguardando_classificacao AND col IS NULL) antes '
  'de emitir movs; limpado no flip pra status=classificada e no sad-path. '
  'Loser concorrente leva 0 rows e rejeita.';

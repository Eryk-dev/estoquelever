-- Decisão 5 (28/05): flag pra avisar separador de validação OC que saldo
-- apareceu em outra OC enquanto ele aguardava. Confere fisicamente antes
-- de marcar Esgotado.

ALTER TABLE siso_pedidos
ADD COLUMN IF NOT EXISTS flag_saldo_apareceu boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pedidos_flag_saldo_apareceu
  ON siso_pedidos(flag_saldo_apareceu)
  WHERE flag_saldo_apareceu = true;

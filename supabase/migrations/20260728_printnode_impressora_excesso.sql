-- Impressora dedicada pra etiqueta de EXCESSO (10×15 paisagem).
--
-- Antes: a etiqueta de excesso saía sempre na impressora de ENVIO do galpão
-- (`printnode_printer_id`) — no CWB isso é a EXPCWB, que fica na embalagem.
-- Depois: mesmo padrão da etiqueta de produto — colunas `_excesso` em
-- galpões e usuários, com fallback pra impressora de envio quando vazias
-- (zero mudança de comportamento até o admin configurar).

ALTER TABLE siso_galpoes
  ADD COLUMN IF NOT EXISTS printnode_printer_id_excesso bigint,
  ADD COLUMN IF NOT EXISTS printnode_printer_nome_excesso text,
  ADD COLUMN IF NOT EXISTS printnode_account_id_excesso uuid
    REFERENCES siso_printnode_contas(id) ON DELETE SET NULL;

ALTER TABLE siso_usuarios
  ADD COLUMN IF NOT EXISTS printnode_printer_id_excesso bigint,
  ADD COLUMN IF NOT EXISTS printnode_printer_nome_excesso text,
  ADD COLUMN IF NOT EXISTS printnode_account_id_excesso uuid
    REFERENCES siso_printnode_contas(id) ON DELETE SET NULL;

COMMENT ON COLUMN siso_galpoes.printnode_printer_id_excesso IS
  'Impressora térmica dedicada pra etiqueta de excesso (10×15 paisagem). NULL = usa printnode_printer_id (mesma da etiqueta de envio).';
COMMENT ON COLUMN siso_usuarios.printnode_printer_id_excesso IS
  'Override por usuário da impressora de etiqueta de excesso. NULL = usa a do galpão.';

-- Index pra resolver impressora rápido (JOIN com contas)
CREATE INDEX IF NOT EXISTS idx_galpoes_printnode_account_excesso
  ON siso_galpoes(printnode_account_id_excesso)
  WHERE printnode_account_id_excesso IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_printnode_account_excesso
  ON siso_usuarios(printnode_account_id_excesso)
  WHERE printnode_account_id_excesso IS NOT NULL;

-- Fase 5 (P082/P149) — permite jobs de manutenção na fila (durabilidade do
-- reconciliador OC + varredura pós-entrada). Relaxa os CHECKs legados pra
-- aceitar tipos novos e os valores-sentinela 'MAINT'/'manutencao' nas colunas
-- legadas (filial/decisao) que esses jobs não usam (a info real vai em payload).
ALTER TABLE siso_fila_execucao DROP CONSTRAINT IF EXISTS chk_fila_tipo;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_tipo
  CHECK (tipo IN ('lancar_estoque','lancar_estoque_pos_nf','varredura_pos_entrada','reconciliar_oc_retry'));

ALTER TABLE siso_fila_execucao DROP CONSTRAINT IF EXISTS chk_fila_filial;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_filial
  CHECK (filial_execucao IN ('CWB','SP','MAINT'));

ALTER TABLE siso_fila_execucao DROP CONSTRAINT IF EXISTS chk_fila_decisao;
ALTER TABLE siso_fila_execucao ADD CONSTRAINT chk_fila_decisao
  CHECK (decisao IN ('propria','transferencia','oc','manutencao'));

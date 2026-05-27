-- P3 #8.10 — Anti-race em receberTransferencia (conditional UPDATE)
--
-- Adiciona coluna transient `recebimento_em_andamento_por` em
-- `siso_transferencias_galpao` pra suportar lock cooperativo via UPDATE
-- condicional (mesmo pattern do `iniciada_por` em `siso_wms_pendencias_guarda`
-- usado pelo Phase 5 #5.2).
--
-- Pré-bug: 2 operadores chamando POST /transferencias/[id]/receber em paralelo:
--   - Ambos passam validação de status='em_transito' (SELECT separado);
--   - Ambos inserem movs E na loc destino → saldo duplicado;
--   - O último UPDATE de status='recebida' simplesmente sobrescreve.
--
-- Fix: ANTES de inserir movs E, tentamos um UPDATE condicional que reivindica
-- a transferência. WHERE id=$1 AND status='em_transito' AND
-- recebimento_em_andamento_por IS NULL. O loser (qualquer chamada concorrente,
-- mesmo do mesmo user) leva 0 rows = 409 + code='TRANSFERENCIA_OUTRO_RECEBIMENTO'.
-- Claim é ESTRITO porque o inner write é INSERT de mov E (não-idempotente até
-- mov_entrada_id ser setado) — diferente do iniciarGuarda em pendências, onde
-- o inner é só status flip (idempotente) e tolera re-entrada do mesmo user.
-- Ao fim do happy-path, o campo é limpado (NULL) — não persiste entre
-- recebimentos (e nem precisa, já que após o sucesso o status vira 'recebida'
-- e o CHECK de status do path receber filtra fora).
--
-- NOTA: o lock é transient/melhor-esforço. Se o processo morrer entre o
-- claim e o flip de status, o campo fica "preso" no usuário. Operacionalmente
-- aceitável — admin pode dar UPDATE manual. Pra hardening completo, RPC
-- atômico seria mais robusto, mas isso fica pro Plano 6 cutover.

ALTER TABLE siso_transferencias_galpao
  ADD COLUMN IF NOT EXISTS recebimento_em_andamento_por uuid REFERENCES siso_usuarios(id);

COMMENT ON COLUMN siso_transferencias_galpao.recebimento_em_andamento_por IS
  'P3 #8.10 — Transient lock anti-race em /receber. NULL = nenhum recebimento em andamento. Preenchido durante a janela de inserção das movs E, limpado ao final do happy-path (status vira recebida). Pattern espelha iniciada_por em siso_wms_pendencias_guarda.';

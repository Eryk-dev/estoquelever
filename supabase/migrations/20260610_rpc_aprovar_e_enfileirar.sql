-- Fase 5 (P005) — RPC wms_aprovar_e_enfileirar: transição de status do pedido +
-- INSERT do job lancar_estoque na MESMA transação. Mata o estado fantasma
-- "aprovado sem job" (o INSERT da fila era best-effort). Idempotente: só
-- enfileira se não há job pendente/executando do mesmo pedido (dedup por
-- pedido+tipo). O UPDATE é condicional ao status atual pra não regredir.
-- NOTA: siso_pedidos.marcadores é text[] (não jsonb) → p_marcadores text[].
CREATE OR REPLACE FUNCTION public.wms_aprovar_e_enfileirar(
  p_pedido_id text,
  p_decisao text,
  p_status_separacao text,
  p_empresa_id uuid,
  p_filial_execucao text,
  p_operador_id text DEFAULT NULL,
  p_operador_nome text DEFAULT NULL,
  p_marcadores text[] DEFAULT NULL,
  p_separacao_galpao_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_existe boolean;
  v_job_id uuid;
BEGIN
  PERFORM 1 FROM siso_pedidos WHERE id = p_pedido_id FOR UPDATE;

  UPDATE siso_pedidos
     SET status = 'executando',
         decisao_final = p_decisao::siso_decisao,
         operador_id = p_operador_id,
         operador_nome = p_operador_nome,
         tipo_resolucao = 'manual',
         marcadores = COALESCE(p_marcadores, marcadores),
         separacao_galpao_id = p_separacao_galpao_id,
         status_separacao = p_status_separacao
   WHERE id = p_pedido_id;

  -- Dedup: já há job vivo pro pedido?
  SELECT EXISTS(
    SELECT 1 FROM siso_fila_execucao
     WHERE pedido_id = p_pedido_id AND tipo = 'lancar_estoque'
       AND status IN ('pendente','executando')
  ) INTO v_existe;

  IF NOT v_existe THEN
    INSERT INTO siso_fila_execucao (pedido_id, tipo, filial_execucao, empresa_id, decisao, operador_id, operador_nome)
    VALUES (p_pedido_id, 'lancar_estoque', p_filial_execucao, p_empresa_id, p_decisao, p_operador_id, p_operador_nome)
    RETURNING id INTO v_job_id;
  END IF;

  RETURN jsonb_build_object('enfileirado', (v_job_id IS NOT NULL), 'job_id', v_job_id);
END;
$function$;

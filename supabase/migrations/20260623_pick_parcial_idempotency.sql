-- BUG-09 (2026-06-23) — wms_pick_parcial_atomico idempotente por idempotency_key.
--
-- Sintoma: um parcial reenviado com o MESMO body (timeout+retry / duplo-clique
-- de rede) passava o guard de re-entrada no ramo residual (loc_zerou=false, em
-- que o item fica propositalmente ABERTO: separacao_marcado=false,
-- separacao_parcial=false) e: (1) emitia uma 2ª saída S (baixa de estoque
-- dobrada); (2) inflava quantidade_pega (4 → 8) via wms_acumular_qty_pega
-- (UPDATE com soma, não-idempotente).
--
-- Fix: a S de venda (ou o ajuste loc_zerou, quando qty_pega=0) carrega a
-- idempotency_key client-gerada. wms_inserir_movimentacao já deduplica a key
-- (UNIQUE parcial uq_mov_idempotency_key → no-op retorna a mov existente). Aqui
-- adicionamos um TOP-CHECK próprio: se a key já existe, retorna
-- ja_aplicado=true SEM reemitir nada — o route usa esse flag (backstop de
-- concorrência) pra pular o acúmulo de quantidade_pega. O caminho feliz do
-- retry sequencial é fechado ANTES, por um guard no route (mesma key).
--
-- ⚠ Exatamente UMA mov por request carrega a key (a S quando qty>0, senão o
-- ajuste) — reusar a mesma key em movs distintas seria rejeitado pelo UNIQUE
-- (vira no-op em vez de inserir a 2ª).

-- Dropa o overload de 10 args (SEM p_idempotency_key) pra evitar ambiguidade no
-- PostgREST quando a chamada omite o novo arg (padrão de 20260607d).
DROP FUNCTION IF EXISTS public.wms_pick_parcial_atomico(
  uuid, uuid, uuid, numeric, numeric, text, uuid, uuid, jsonb, text
);

CREATE OR REPLACE FUNCTION public.wms_pick_parcial_atomico(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_qty_pega numeric, p_delta_ajuste numeric, p_pedido_id text,
  p_empresa_vendedora_id uuid, p_usuario_id uuid DEFAULT NULL,
  p_origem_detalhes jsonb DEFAULT NULL, p_motivo text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE v_s_id uuid; v_aj_id uuid; v_existente uuid;
BEGIN
  -- Backstop de idempotência: se a key já foi consumida por este request
  -- (S OU ajuste já emitidos), não reaplica nada. Fecha a janela de
  -- concorrência em que dois requests idênticos passam o guard do route antes
  -- de qualquer commit — o vencedor grava a S com a key; o perdedor cai aqui.
  --
  -- O advisory xact lock por key SERIALIZA requests com a mesma key: sem ele o
  -- top-check abaixo é um read não-locking e o perdedor podia passar (ja_aplicado
  -- =false) e, mesmo com a S deduplicada lá dentro (no-op de wms_inserir_movimentacao),
  -- voltar pro route e acumular quantidade_pega 2x (o ramo residual loc_zerou=false
  -- pula o Pass A → sem rollback). Com o lock, o perdedor só passa após o COMMIT
  -- do vencedor → o top-check ENXERGA a S e retorna ja_aplicado=true. O lock é
  -- liberado no fim da tx da RPC (antes do route acumular).
  -- (Depende de READ COMMITTED — default do PostgREST/Supabase: o top-check do
  -- perdedor é um statement novo, com snapshot pós-commit do vencedor. Se a
  -- conexão fosse REPEATABLE READ, o top-check podia perder a S; a UNIQUE
  -- uq_mov_idempotency_key ainda barraria a 2ª S, só o flag ja_aplicado erraria.)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    SELECT id INTO v_existente
      FROM siso_movimentacoes WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'mov_s_id', v_existente, 'mov_ajuste_id', NULL, 'ja_aplicado', true
      );
    END IF;
  END IF;

  IF p_qty_pega > 0 THEN
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_produto_id, p_galpao_id := p_galpao_id, p_localizacao_id := p_localizacao_id,
      p_tipo := 'S', p_quantidade := p_qty_pega, p_origem_tipo := 'nf_venda', p_origem_id := p_pedido_id,
      p_origem_detalhes := p_origem_detalhes, p_empresa_vendedora_id := p_empresa_vendedora_id,
      p_usuario_id := p_usuario_id, p_pedido_id := p_pedido_id,
      p_motivo := COALESCE(p_motivo, 'Picking parcial — saída'),
      p_idempotency_key := p_idempotency_key
    ) INTO v_s_id;
  END IF;

  IF p_delta_ajuste > 0 THEN
    SELECT wms_inserir_movimentacao(
      p_produto_id := p_produto_id, p_galpao_id := p_galpao_id, p_localizacao_id := p_localizacao_id,
      p_tipo := 'S', p_quantidade := p_delta_ajuste, p_origem_tipo := 'ajuste_pick_zerou',
      p_origem_id := p_pedido_id, p_origem_detalhes := p_origem_detalhes, p_usuario_id := p_usuario_id,
      p_motivo := 'loc zerou no bipe',
      -- A key vai na S de venda quando há qty; só carrega no ajuste quando NÃO
      -- houve S (qty_pega=0, loc_zerou=true) — assim o request fica deduplicável
      -- sem dois registros disputando a mesma key.
      p_idempotency_key := CASE WHEN p_qty_pega > 0 THEN NULL ELSE p_idempotency_key END
    ) INTO v_aj_id;
  END IF;

  RETURN jsonb_build_object(
    'mov_s_id', v_s_id, 'mov_ajuste_id', v_aj_id, 'ja_aplicado', false
  );
END;
$function$;

-- Permite corrigir o saldo físico abaixo do reservado sem cancelar pedidos.
-- Antes da saída, move cada R viva de pedido por inteiro para outra posição
-- ativa do mesmo produto/galpão com capacidade. L + R + S ficam na mesma
-- transação: qualquer falha preserva a reserva e o saldo originais.

BEGIN;

CREATE OR REPLACE FUNCTION public.wms_ajustar_estoque_realocando_reservas(
  p_produto_id uuid,
  p_galpao_id uuid,
  p_localizacao_id uuid,
  p_quantidade numeric,
  p_direcao text,
  p_motivo text,
  p_motivo_categoria text,
  p_usuario_id uuid,
  p_custo_unitario numeric DEFAULT NULL,
  p_localizacoes_saida uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_saldo numeric;
  v_reservado numeric;
  v_deficit numeric;
  v_reserva record;
  v_destino_id uuid;
  v_mov_id uuid;
  v_mov_l_id uuid;
  v_mov_r_id uuid;
  v_reservas_realocadas integer := 0;
  v_quantidade_realocada numeric := 0;
BEGIN
  IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
    RAISE EXCEPTION 'qty deve ser > 0' USING ERRCODE = '22023';
  END IF;
  IF p_direcao NOT IN ('entrada', 'saida') THEN
    RAISE EXCEPTION 'direcao deve ser entrada ou saida' USING ERRCODE = '22023';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo do ajuste e obrigatorio (>=3 caracteres)'
      USING ERRCODE = '22023';
  END IF;

  IF p_direcao = 'saida' THEN
    SELECT e.saldo, e.reservado
      INTO v_saldo, v_reservado
      FROM public.siso_estoque e
     WHERE e.produto_id = p_produto_id
       AND e.galpao_id = p_galpao_id
       AND e.localizacao_id = p_localizacao_id
     FOR UPDATE;

    IF NOT FOUND OR v_saldo < p_quantidade THEN
      RAISE EXCEPTION 'saida % excede saldo atual %', p_quantidade, COALESCE(v_saldo, 0)
        USING ERRCODE = '22023';
    END IF;

    v_deficit := GREATEST(0, v_reservado - (v_saldo - p_quantidade));

    -- R de pedido e all-or-nothing por movimento. Movemos a R inteira; isso
    -- pode liberar um pouco mais que o deficit, mas nunca reduz a reserva do
    -- pedido nem cria uma R parcial que o pick simples nao consiga consumir.
    FOR v_reserva IN
      SELECT m.*
        FROM public.siso_movimentacoes m
       WHERE m.produto_id = p_produto_id
         AND m.galpao_id = p_galpao_id
         AND m.localizacao_id = p_localizacao_id
         AND m.tipo = 'R'
         AND m.origem_tipo = 'reserva_pedido'
         AND NOT EXISTS (
           SELECT 1
             FROM public.siso_movimentacoes l
            WHERE l.tipo = 'L' AND l.estorno_de = m.id
         )
       ORDER BY m.quantidade DESC, m.criado_em, m.id
       FOR UPDATE OF m
    LOOP
      EXIT WHEN v_deficit <= 0;

      SELECT e.localizacao_id
        INTO v_destino_id
        FROM public.siso_estoque e
        JOIN public.siso_localizacoes loc ON loc.id = e.localizacao_id
       WHERE e.produto_id = p_produto_id
         AND e.galpao_id = p_galpao_id
         AND e.localizacao_id <> p_localizacao_id
         AND NOT (e.localizacao_id = ANY(COALESCE(p_localizacoes_saida, '{}'::uuid[])))
         AND e.saldo - e.reservado >= v_reserva.quantidade
         AND loc.ativo
         AND loc.tipo NOT IN ('quarentena', 'expedicao')
         AND NOT EXISTS (
           SELECT 1
             FROM public.siso_localizacao_locks lk
            WHERE lk.localizacao_id = e.localizacao_id
              AND lk.finalizado_em IS NULL
         )
       ORDER BY CASE WHEN loc.tipo = 'picking' THEN 0 ELSE 1 END,
                (e.saldo - e.reservado) DESC,
                loc.codigo
       LIMIT 1
       FOR UPDATE OF e;

      IF v_destino_id IS NULL THEN
        RAISE EXCEPTION
          'nao foi possivel realocar a reserva de % un: nenhuma outra localizacao ativa tem saldo livre suficiente',
          v_reserva.quantidade
          USING ERRCODE = '22023';
      END IF;

      SELECT public.wms_inserir_movimentacao(
        p_produto_id := v_reserva.produto_id,
        p_galpao_id := v_reserva.galpao_id,
        p_localizacao_id := v_reserva.localizacao_id,
        p_tipo := 'L'::char(1),
        p_quantidade := v_reserva.quantidade,
        p_origem_tipo := 'liberacao_reserva',
        p_origem_id := v_reserva.origem_id,
        p_origem_detalhes := COALESCE(v_reserva.origem_detalhes, '{}'::jsonb)
          || jsonb_build_object(
            'contexto', 'ajuste_manual_realocacao_reserva',
            'reserva_origem', v_reserva.id,
            'destino_localizacao_id', v_destino_id
          ),
        p_usuario_id := p_usuario_id,
        p_estorno_de := v_reserva.id,
        p_empresa_compradora_id := v_reserva.empresa_compradora_id,
        p_empresa_vendedora_id := v_reserva.empresa_vendedora_id,
        p_empresa_referencia_id := v_reserva.empresa_referencia_id,
        p_fornecedor_id := v_reserva.fornecedor_id,
        p_motivo := 'Reserva realocada por ajuste manual: ' || trim(p_motivo),
        p_cliente_nome := v_reserva.cliente_nome,
        p_pedido_id := v_reserva.pedido_id,
        p_nota_fiscal_id := v_reserva.nota_fiscal_id,
        p_chave_acesso_nf := v_reserva.chave_acesso_nf
      ) INTO v_mov_l_id;

      SELECT public.wms_inserir_movimentacao(
        p_produto_id := v_reserva.produto_id,
        p_galpao_id := v_reserva.galpao_id,
        p_localizacao_id := v_destino_id,
        p_tipo := 'R'::char(1),
        p_quantidade := v_reserva.quantidade,
        p_origem_tipo := 'reserva_pedido',
        p_origem_id := v_reserva.origem_id,
        p_origem_detalhes := COALESCE(v_reserva.origem_detalhes, '{}'::jsonb)
          || jsonb_build_object(
            'contexto', 'ajuste_manual_realocacao_reserva',
            'reserva_origem', v_reserva.id,
            'origem_localizacao_id', p_localizacao_id,
            'mov_l_id', v_mov_l_id
          ),
        p_usuario_id := p_usuario_id,
        p_expira_em := v_reserva.expira_em,
        p_empresa_compradora_id := v_reserva.empresa_compradora_id,
        p_empresa_vendedora_id := v_reserva.empresa_vendedora_id,
        p_empresa_referencia_id := v_reserva.empresa_referencia_id,
        p_fornecedor_id := v_reserva.fornecedor_id,
        p_motivo := 'Reserva realocada por ajuste manual: ' || trim(p_motivo),
        p_cliente_nome := v_reserva.cliente_nome,
        p_pedido_id := v_reserva.pedido_id,
        p_nota_fiscal_id := v_reserva.nota_fiscal_id,
        p_chave_acesso_nf := v_reserva.chave_acesso_nf
      ) INTO v_mov_r_id;

      v_reservas_realocadas := v_reservas_realocadas + 1;
      v_quantidade_realocada := v_quantidade_realocada + v_reserva.quantidade;
      v_deficit := v_deficit - v_reserva.quantidade;
      v_destino_id := NULL;
    END LOOP;

    IF v_deficit > 0 THEN
      RAISE EXCEPTION
        'saldo real ficaria abaixo do reservado e % un nao puderam ser realocadas; libere reservas nao vinculadas a pedido',
        v_deficit
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT public.wms_inserir_movimentacao(
    p_produto_id := p_produto_id,
    p_galpao_id := p_galpao_id,
    p_localizacao_id := p_localizacao_id,
    p_tipo := CASE WHEN p_direcao = 'entrada' THEN 'E' ELSE 'S' END::char(1),
    p_quantidade := p_quantidade,
    p_origem_tipo := 'ajuste_manual',
    p_origem_detalhes := jsonb_build_object(
      'direcao', p_direcao,
      'reservas_realocadas', v_reservas_realocadas,
      'quantidade_realocada', v_quantidade_realocada
    ),
    p_usuario_id := p_usuario_id,
    p_motivo := trim(p_motivo),
    p_custo_unitario := CASE WHEN p_direcao = 'entrada' THEN p_custo_unitario ELSE NULL END,
    p_motivo_categoria := p_motivo_categoria
  ) INTO v_mov_id;

  RETURN jsonb_build_object(
    'mov_id', v_mov_id,
    'reservas_realocadas', v_reservas_realocadas,
    'quantidade_realocada', v_quantidade_realocada
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.wms_ajustar_estoque_realocando_reservas(
  uuid, uuid, uuid, numeric, text, text, text, uuid, numeric, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_ajustar_estoque_realocando_reservas(
  uuid, uuid, uuid, numeric, text, text, text, uuid, numeric, uuid[]
) TO service_role;

COMMIT;

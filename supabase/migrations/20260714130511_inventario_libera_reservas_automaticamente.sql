-- Inventário é a fonte de verdade do saldo físico.
--
-- Antes, uma perda que deixasse saldo < reservado abortava a sessão e exigia
-- liberação manual. Agora a própria aplicação libera somente o excesso de
-- reservas, na mesma transação e antes da saída de inventário:
--   * reserva_guarda: L parcial (o fluxo de guarda já trabalha por net R-L);
--   * reserva_troca: L total + expira a troca pendente;
--   * reserva_pedido: L total e, se necessário, recria apenas o remanescente.
-- Pedidos que perderam cobertura vão para pendente_realocacao.

BEGIN;

CREATE OR REPLACE FUNCTION public.wms_aplicar_sessao_inventario(
  p_sessao uuid,
  p_usuario uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_status                text;
  v_galpao                uuid;
  v_div                   RECORD;
  v_tipo                  char(1);
  v_qty                   numeric;
  v_custo                 numeric;
  v_mov_id                uuid;
  v_count                 integer := 0;
  v_saldo                 numeric;
  v_reservado             numeric;
  v_sku                   text;
  v_loc_codigo            text;
  v_liberar_falta         numeric;
  v_liberar               numeric;
  v_restante              numeric;
  v_res                   RECORD;
  v_guarda                RECORD;
  v_l_id                  uuid;
  v_nova_r_id             uuid;
  v_reservas_liberadas    integer := 0;
  v_quantidade_liberada   numeric := 0;
BEGIN
  SELECT status, galpao_id INTO v_status, v_galpao
    FROM siso_inventario_sessoes
   WHERE id = p_sessao
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sessão % não encontrada', p_sessao USING ERRCODE = 'P0002';
  END IF;

  IF v_status = 'aplicada' THEN
    SELECT count(*) INTO v_count
      FROM siso_movimentacoes m
     WHERE m.origem_id = p_sessao::text
       AND m.origem_tipo IN ('inventario_ganho', 'inventario_perda')
       AND NOT EXISTS (SELECT 1 FROM siso_movimentacoes e WHERE e.estorno_de = m.id);
    RETURN jsonb_build_object(
      'movs_geradas', v_count,
      'reservas_liberadas', 0,
      'quantidade_liberada', 0,
      'idempotente', true
    );
  END IF;

  IF v_status <> 'aprovada' THEN
    RAISE EXCEPTION 'sessão % não está aprovada (status=%)', p_sessao, v_status
      USING ERRCODE = '22023';
  END IF;

  FOR v_div IN
    SELECT id, produto_id, localizacao_id, delta, delta_pct, aplicacoes
      FROM siso_inventario_divergencias
     WHERE sessao_id = p_sessao
       AND status = 'aprovada'
     ORDER BY id
  LOOP
    IF v_div.delta = 0 THEN CONTINUE; END IF;
    v_tipo := CASE WHEN v_div.delta > 0 THEN 'E' ELSE 'S' END;
    v_qty  := abs(v_div.delta);

    IF v_tipo = 'S' THEN
      -- A linha do cache é o lock canônico da tripla. Toda R/L/S passa por
      -- wms_inserir_movimentacao e espera este lock, então nenhum reservado
      -- muda entre o cálculo, as liberações e a perda.
      SELECT COALESCE(saldo, 0), COALESCE(reservado, 0)
        INTO v_saldo, v_reservado
        FROM siso_estoque
       WHERE produto_id = v_div.produto_id
         AND galpao_id = v_galpao
         AND localizacao_id = v_div.localizacao_id
       FOR UPDATE;
      IF NOT FOUND THEN
        v_saldo := 0;
        v_reservado := 0;
      END IF;

      SELECT sku INTO v_sku FROM siso_produtos WHERE id = v_div.produto_id;
      SELECT codigo INTO v_loc_codigo FROM siso_localizacoes WHERE id = v_div.localizacao_id;

      IF v_saldo - v_qty < 0 THEN
        RAISE EXCEPTION 'divergência % (produto %, loc %): perda % maior que o saldo atual % — rejeite essa divergência e re-aplique a sessão',
          v_div.id, v_sku, v_loc_codigo, v_qty, v_saldo
          USING ERRCODE = '22023';
      END IF;

      v_liberar_falta := GREATEST(0, v_reservado - (v_saldo - v_qty));

      -- Reserva de guarda representa peça ainda na loc de recebimento. Se o
      -- inventário não a encontrou, ela é a primeira a ceder. Guarda aceita
      -- L parcial e calcula vivacidade pelo net SUM(R)-SUM(L).
      FOR v_guarda IN
        WITH nets AS (
          SELECT origem_id,
                 GREATEST(0, SUM(CASE
                   WHEN origem_tipo = 'reserva_guarda' AND tipo = 'R' THEN quantidade
                   WHEN origem_tipo = 'liberacao_guarda' AND tipo = 'L' THEN -quantidade
                   ELSE 0
                 END)) AS quantidade,
                 MAX(criado_em) FILTER (
                   WHERE origem_tipo = 'reserva_guarda' AND tipo = 'R'
                 ) AS ultima_reserva_em
            FROM siso_movimentacoes
           WHERE produto_id = v_div.produto_id
             AND galpao_id = v_galpao
             AND localizacao_id = v_div.localizacao_id
             AND origem_tipo IN ('reserva_guarda', 'liberacao_guarda')
           GROUP BY origem_id
          HAVING SUM(CASE
                   WHEN origem_tipo = 'reserva_guarda' AND tipo = 'R' THEN quantidade
                   WHEN origem_tipo = 'liberacao_guarda' AND tipo = 'L' THEN -quantidade
                   ELSE 0
                 END) > 0
        )
        SELECT n.origem_id, n.quantidade,
               (
                 SELECT m.id
                   FROM siso_movimentacoes m
                  WHERE m.produto_id = v_div.produto_id
                    AND m.galpao_id = v_galpao
                    AND m.localizacao_id = v_div.localizacao_id
                    AND m.tipo = 'R'
                    AND m.origem_tipo = 'reserva_guarda'
                    AND m.origem_id = n.origem_id
                  ORDER BY m.criado_em DESC, m.id DESC
                  LIMIT 1
               ) AS reserva_id
          FROM nets n
         ORDER BY n.ultima_reserva_em DESC, n.origem_id
      LOOP
        EXIT WHEN v_liberar_falta <= 0;
        v_liberar := LEAST(v_liberar_falta, v_guarda.quantidade);

        SELECT wms_inserir_movimentacao(
          p_produto_id := v_div.produto_id,
          p_galpao_id := v_galpao,
          p_localizacao_id := v_div.localizacao_id,
          p_tipo := 'L'::char(1),
          p_quantidade := v_liberar,
          p_origem_tipo := 'liberacao_guarda',
          p_origem_id := v_guarda.origem_id,
          p_origem_detalhes := jsonb_build_object(
            'parcial', true,
            'contexto', 'inventario_fonte_verdade',
            'sessao_id', p_sessao,
            'divergencia_id', v_div.id
          ),
          p_usuario_id := p_usuario,
          p_estorno_de := v_guarda.reserva_id,
          p_motivo := 'reserva liberada automaticamente pelo inventário'
        ) INTO v_l_id;

        v_liberar_falta := v_liberar_falta - v_liberar;
        v_reservas_liberadas := v_reservas_liberadas + 1;
        v_quantidade_liberada := v_quantidade_liberada + v_liberar;
      END LOOP;

      -- Trocas pendentes cedem antes de pedidos confirmados. Reserva de troca
      -- é all-or-nothing: ao perder qualquer cobertura, libera toda a R e
      -- expira a solicitação. Reserva de pedido pode manter um remanescente.
      FOR v_res IN
        SELECT m.*
          FROM siso_movimentacoes m
         WHERE m.produto_id = v_div.produto_id
           AND m.galpao_id = v_galpao
           AND m.localizacao_id = v_div.localizacao_id
           AND m.tipo = 'R'
           AND m.origem_tipo IN ('reserva_troca', 'reserva_pedido')
           AND NOT EXISTS (
             SELECT 1 FROM siso_movimentacoes l
              WHERE l.tipo = 'L' AND l.estorno_de = m.id
           )
         ORDER BY CASE WHEN m.origem_tipo = 'reserva_troca' THEN 0 ELSE 1 END,
                  m.criado_em DESC, m.id DESC
      LOOP
        EXIT WHEN v_liberar_falta <= 0;
        v_liberar := CASE
          WHEN v_res.origem_tipo = 'reserva_troca' THEN v_res.quantidade
          ELSE LEAST(v_liberar_falta, v_res.quantidade)
        END;
        v_restante := v_res.quantidade - v_liberar;

        SELECT wms_inserir_movimentacao(
          p_produto_id := v_res.produto_id,
          p_galpao_id := v_res.galpao_id,
          p_localizacao_id := v_res.localizacao_id,
          p_tipo := 'L'::char(1),
          p_quantidade := v_res.quantidade,
          p_origem_tipo := CASE
            WHEN v_res.origem_tipo = 'reserva_troca' THEN 'liberacao_troca'
            ELSE 'liberacao_reserva'
          END,
          p_origem_id := v_res.origem_id,
          p_origem_detalhes := jsonb_build_object(
            'reserva_origem', v_res.id,
            'contexto', 'inventario_fonte_verdade',
            'sessao_id', p_sessao,
            'divergencia_id', v_div.id,
            'quantidade_cancelada', v_liberar
          ),
          p_usuario_id := p_usuario,
          p_estorno_de := v_res.id,
          p_empresa_compradora_id := v_res.empresa_compradora_id,
          p_empresa_vendedora_id := v_res.empresa_vendedora_id,
          p_empresa_referencia_id := v_res.empresa_referencia_id,
          p_fornecedor_id := v_res.fornecedor_id,
          p_cliente_nome := v_res.cliente_nome,
          p_pedido_id := v_res.pedido_id,
          p_nota_fiscal_id := v_res.nota_fiscal_id,
          p_chave_acesso_nf := v_res.chave_acesso_nf,
          p_motivo := 'reserva liberada automaticamente pelo inventário'
        ) INTO v_l_id;

        IF v_restante > 0 THEN
          SELECT wms_inserir_movimentacao(
            p_produto_id := v_res.produto_id,
            p_galpao_id := v_res.galpao_id,
            p_localizacao_id := v_res.localizacao_id,
            p_tipo := 'R'::char(1),
            p_quantidade := v_restante,
            p_origem_tipo := v_res.origem_tipo,
            p_origem_id := v_res.origem_id,
            p_origem_detalhes := COALESCE(v_res.origem_detalhes, '{}'::jsonb)
              || jsonb_build_object(
                'reserva_origem', v_res.id,
                'contexto', 'remanescente_pos_inventario',
                'sessao_id', p_sessao,
                'divergencia_id', v_div.id
              ),
            p_usuario_id := p_usuario,
            p_expira_em := v_res.expira_em,
            p_empresa_compradora_id := v_res.empresa_compradora_id,
            p_empresa_vendedora_id := v_res.empresa_vendedora_id,
            p_empresa_referencia_id := v_res.empresa_referencia_id,
            p_fornecedor_id := v_res.fornecedor_id,
            p_cliente_nome := v_res.cliente_nome,
            p_pedido_id := v_res.pedido_id,
            p_nota_fiscal_id := v_res.nota_fiscal_id,
            p_chave_acesso_nf := v_res.chave_acesso_nf,
            p_motivo := 'remanescente de reserva após inventário'
          ) INTO v_nova_r_id;
        END IF;

        IF v_res.origem_tipo = 'reserva_troca' THEN
          UPDATE siso_trocas_equivalencia
             SET status = 'expirada',
                 decidido_por = p_usuario,
                 decidido_em = now(),
                 motivo_rejeicao = 'Reserva liberada automaticamente por perda de inventário'
           WHERE id::text = v_res.origem_id
             AND status = 'pendente';
        END IF;

        IF COALESCE(v_res.pedido_id, v_res.origem_id) IS NOT NULL THEN
          UPDATE siso_pedidos
             SET status_separacao = 'pendente_realocacao'
           WHERE id = COALESCE(v_res.pedido_id, v_res.origem_id)
             AND status_separacao IN (
               'aguardando_compra', 'aguardando_nf', 'validacao_oc',
               'aguardando_separacao', 'em_separacao', 'pendente_realocacao'
             );
        END IF;

        v_liberar_falta := GREATEST(0, v_liberar_falta - v_liberar);
        v_reservas_liberadas := v_reservas_liberadas + 1;
        v_quantidade_liberada := v_quantidade_liberada + v_liberar;
      END LOOP;

      IF v_liberar_falta > 0 THEN
        RAISE EXCEPTION 'divergência % (produto %, loc %): não foi possível identificar % do reservado vivo para liberação automática',
          v_div.id, v_sku, v_loc_codigo, v_liberar_falta
          USING ERRCODE = '22023';
      END IF;
    END IF;

    v_custo := NULL;
    IF v_tipo = 'E' THEN
      SELECT custo_medio INTO v_custo
        FROM siso_custo_medio
       WHERE produto_id = v_div.produto_id;
    END IF;

    SELECT wms_inserir_movimentacao(
      p_produto_id := v_div.produto_id,
      p_galpao_id := v_galpao,
      p_localizacao_id := v_div.localizacao_id,
      p_tipo := v_tipo,
      p_quantidade := v_qty,
      p_origem_tipo := CASE WHEN v_tipo = 'E' THEN 'inventario_ganho' ELSE 'inventario_perda' END,
      p_origem_id := p_sessao::text,
      p_origem_detalhes := jsonb_build_object(
        'divergencia_id', v_div.id,
        'delta_pct', v_div.delta_pct,
        'aplicacao', v_div.aplicacoes
      ),
      p_custo_unitario := v_custo,
      p_usuario_id := p_usuario,
      p_motivo := 'inventário sessão ' || p_sessao::text
    ) INTO v_mov_id;

    UPDATE siso_inventario_divergencias
       SET status = 'aplicada', mov_aplicada_id = v_mov_id
     WHERE id = v_div.id;
    v_count := v_count + 1;
  END LOOP;

  UPDATE siso_localizacao_locks
     SET finalizado_em = now()
   WHERE finalizado_em IS NULL
     AND (
       sessao_id = p_sessao
       OR (sessao_id IS NULL AND localizacao_id IN (
         SELECT localizacao_id
           FROM siso_inventario_localizacoes
          WHERE sessao_id = p_sessao
       ))
     );

  UPDATE siso_inventario_sessoes
     SET status = 'aplicada', aplicada_em = now()
   WHERE id = p_sessao;

  RETURN jsonb_build_object(
    'movs_geradas', v_count,
    'reservas_liberadas', v_reservas_liberadas,
    'quantidade_liberada', v_quantidade_liberada,
    'idempotente', false
  );
END;
$function$;

COMMENT ON FUNCTION public.wms_aplicar_sessao_inventario(uuid,uuid) IS
  'Aplica divergências de inventário tudo-ou-nada; perdas liberam automaticamente o excesso reservado e enviam pedidos afetados para pendente_realocacao.';

COMMIT;

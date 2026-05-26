-- Fix: wms_inserir_movimentacao não recalculava custo_medio em entradas
-- com origem_tipo='ajuste_manual' ou 'inventario_inicial', mesmo quando
-- o usuário fornecia custo_unitario. Resultado: produtos com saldo > 0
-- e custo_medio=0 (ex.: ACD003, 100 unidades a R$10,00 ficou com valor R$0).
--
-- Origens que devem compor custo médio (entradas com custo_unitario):
--   - nf_compra              ─ compra de fornecedor (já era contemplado)
--   - devolucao_cliente_integra ─ devolução íntegra reentra ao acervo (já)
--   - lancamento_retroativo  ─ reconcilia entrada histórica (já)
--   - ajuste_manual          ─ entrada manual com nota de custo (NOVO)
--   - inventario_inicial     ─ snapshot inicial / migração do estoque (NOVO)
--
-- Origens explicitamente EXCLUÍDAS:
--   - inventario_ganho       ─ sobra encontrada em contagem; custo herda o vigente
--   - estorno                ─ desfaz mov anterior; custo já está reconciliado
--   - devolucao_fornecedor_* ─ típicamente sem custo_unitario informado
--   - transferencia_*        ─ mov interna, não muda custo
--
-- Backfill: replay cronológico de TODAS as movs por produto pra recompor
-- o custo médio atual no cache siso_custo_medio. Não toca em
-- siso_movimentacoes (ledger imutável — colunas custo_medio_anterior/
-- posterior das movs históricas ficam com o valor que tiveram no
-- momento da inserção; ledger preserva o que o RPC viu na época).

-- 1) Atualiza RPC
CREATE OR REPLACE FUNCTION public.wms_inserir_movimentacao(
  p_produto_id uuid, p_galpao_id uuid, p_localizacao_id uuid,
  p_tipo character, p_quantidade numeric,
  p_origem_tipo text, p_origem_id text DEFAULT NULL::text,
  p_origem_detalhes jsonb DEFAULT NULL::jsonb,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_expira_em timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_estorno_de uuid DEFAULT NULL::uuid,
  p_empresa_compradora_id uuid DEFAULT NULL::uuid,
  p_empresa_vendedora_id uuid DEFAULT NULL::uuid,
  p_empresa_referencia_id uuid DEFAULT NULL::uuid,
  p_fornecedor_id uuid DEFAULT NULL::uuid,
  p_motivo text DEFAULT NULL::text,
  p_cliente_nome text DEFAULT NULL::text,
  p_pedido_id text DEFAULT NULL::text,
  p_nota_fiscal_id uuid DEFAULT NULL::uuid,
  p_chave_acesso_nf text DEFAULT NULL::text,
  p_custo_unitario numeric DEFAULT NULL::numeric
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_mov_id              uuid;
  v_saldo_anterior      numeric;
  v_saldo_posterior     numeric;
  v_reservado_anterior  numeric;
  v_reservado_posterior numeric;
  v_custo_medio_atual   numeric;
  v_custo_medio_novo    numeric;
  v_saldo_global        numeric;
  v_recalcula_custo     boolean;
BEGIN
  IF p_tipo NOT IN ('E','S','R','L') THEN RAISE EXCEPTION 'tipo inválido: %', p_tipo; END IF;
  IF p_tipo = 'R' AND p_expira_em IS NULL THEN RAISE EXCEPTION 'reserva (tipo R) exige expira_em'; END IF;
  IF p_tipo <> 'R' AND p_expira_em IS NOT NULL THEN RAISE EXCEPTION 'expira_em só é válido pra tipo R'; END IF;

  SELECT saldo, reservado INTO v_saldo_anterior, v_reservado_anterior
    FROM siso_estoque
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo_anterior := 0;
    v_reservado_anterior := 0;
    INSERT INTO siso_estoque (produto_id, galpao_id, localizacao_id, saldo, reservado)
    VALUES (p_produto_id, p_galpao_id, p_localizacao_id, 0, 0);
  END IF;

  v_saldo_posterior := v_saldo_anterior;
  v_reservado_posterior := v_reservado_anterior;
  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo_anterior + p_quantidade;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo_anterior - p_quantidade;
    IF v_saldo_posterior < 0 THEN RAISE EXCEPTION 'saldo insuficiente: % - % < 0', v_saldo_anterior, p_quantidade; END IF;
  ELSIF p_tipo = 'R' THEN
    v_reservado_posterior := v_reservado_anterior + p_quantidade;
    IF v_reservado_posterior > v_saldo_anterior THEN RAISE EXCEPTION 'reserva excede saldo: % + % > %', v_reservado_anterior, p_quantidade, v_saldo_anterior; END IF;
  ELSIF p_tipo = 'L' THEN
    v_reservado_posterior := v_reservado_anterior - p_quantidade;
    IF v_reservado_posterior < 0 THEN RAISE EXCEPTION 'liberação excede reservado: % - % < 0', v_reservado_anterior, p_quantidade; END IF;
  END IF;

  -- WHITELIST: origens de entrada que compõem custo médio quando custo_unitario é informado.
  v_recalcula_custo := (p_tipo = 'E' AND p_custo_unitario IS NOT NULL
                        AND p_origem_tipo IN (
                          'nf_compra',
                          'devolucao_cliente_integra',
                          'lancamento_retroativo',
                          'ajuste_manual',
                          'inventario_inicial'
                        ));

  SELECT COALESCE(custo_medio, 0) INTO v_custo_medio_atual
    FROM siso_custo_medio WHERE produto_id=p_produto_id FOR UPDATE;
  IF NOT FOUND THEN v_custo_medio_atual := 0; END IF;
  v_custo_medio_novo := v_custo_medio_atual;

  IF v_recalcula_custo THEN
    SELECT COALESCE(SUM(saldo),0) INTO v_saldo_global FROM siso_estoque WHERE produto_id=p_produto_id;
    IF v_saldo_global + p_quantidade > 0 THEN
      v_custo_medio_novo := (v_saldo_global * v_custo_medio_atual + p_quantidade * p_custo_unitario) / (v_saldo_global + p_quantidade);
    ELSE
      v_custo_medio_novo := p_custo_unitario;
    END IF;
  END IF;

  INSERT INTO siso_movimentacoes (
    produto_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    usuario_id, expira_em, estorno_de,
    empresa_compradora_id, empresa_vendedora_id, empresa_referencia_id,
    fornecedor_id, motivo, cliente_nome,
    pedido_id, nota_fiscal_id, chave_acesso_nf,
    custo_unitario, custo_medio_anterior, custo_medio_posterior
  ) VALUES (
    p_produto_id, p_galpao_id, p_localizacao_id,
    p_tipo, p_quantidade,
    v_saldo_anterior, v_saldo_posterior,
    v_reservado_anterior, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_usuario_id, p_expira_em, p_estorno_de,
    p_empresa_compradora_id, p_empresa_vendedora_id, p_empresa_referencia_id,
    p_fornecedor_id, p_motivo, p_cliente_nome,
    p_pedido_id, p_nota_fiscal_id, p_chave_acesso_nf,
    p_custo_unitario, v_custo_medio_atual, v_custo_medio_novo
  ) RETURNING id INTO v_mov_id;

  UPDATE siso_estoque
     SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
   WHERE produto_id=p_produto_id AND galpao_id=p_galpao_id AND localizacao_id=p_localizacao_id;

  IF v_recalcula_custo THEN
    INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
    VALUES (p_produto_id, v_custo_medio_novo, v_mov_id, now())
    ON CONFLICT (produto_id) DO UPDATE
      SET custo_medio = EXCLUDED.custo_medio,
          ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
          atualizado_em = EXCLUDED.atualizado_em;
  END IF;

  RETURN v_mov_id;
END;
$function$;

-- 2) Backfill siso_custo_medio: replay cronológico das movs com origem
-- na whitelist nova. Roda só pra produtos que têm pelo menos 1 entrada
-- elegível mas custo_medio atual = 0 ou ausente.
DO $$
DECLARE
  v_produto_id          uuid;
  v_mov                 record;
  v_saldo_global        numeric;
  v_custo_medio_atual   numeric;
  v_custo_medio_novo    numeric;
  v_ultima_mov_id       uuid;
BEGIN
  FOR v_produto_id IN
    SELECT DISTINCT m.produto_id
      FROM siso_movimentacoes m
 LEFT JOIN siso_custo_medio cm ON cm.produto_id = m.produto_id
     WHERE m.tipo = 'E'
       AND m.custo_unitario IS NOT NULL
       AND m.origem_tipo IN ('ajuste_manual','inventario_inicial')
       AND COALESCE(cm.custo_medio, 0) = 0
  LOOP
    v_custo_medio_atual := 0;
    v_saldo_global := 0;
    v_ultima_mov_id := NULL;

    FOR v_mov IN
      SELECT id, tipo, quantidade, custo_unitario, origem_tipo
        FROM siso_movimentacoes
       WHERE produto_id = v_produto_id
       ORDER BY criado_em ASC, id ASC
    LOOP
      IF v_mov.tipo = 'E' THEN
        IF v_mov.custo_unitario IS NOT NULL
           AND v_mov.origem_tipo IN (
             'nf_compra','devolucao_cliente_integra','lancamento_retroativo',
             'ajuste_manual','inventario_inicial'
           )
        THEN
          IF v_saldo_global + v_mov.quantidade > 0 THEN
            v_custo_medio_novo := (v_saldo_global * v_custo_medio_atual
                                   + v_mov.quantidade * v_mov.custo_unitario)
                                  / (v_saldo_global + v_mov.quantidade);
          ELSE
            v_custo_medio_novo := v_mov.custo_unitario;
          END IF;
          v_custo_medio_atual := v_custo_medio_novo;
          v_ultima_mov_id := v_mov.id;
        END IF;
        v_saldo_global := v_saldo_global + v_mov.quantidade;
      ELSIF v_mov.tipo = 'S' THEN
        v_saldo_global := v_saldo_global - v_mov.quantidade;
      END IF;
      -- R e L não afetam saldo global nem custo
    END LOOP;

    IF v_custo_medio_atual > 0 THEN
      INSERT INTO siso_custo_medio (produto_id, custo_medio, ultima_movimentacao_id, atualizado_em)
      VALUES (v_produto_id, v_custo_medio_atual, v_ultima_mov_id, now())
      ON CONFLICT (produto_id) DO UPDATE
        SET custo_medio = EXCLUDED.custo_medio,
            ultima_movimentacao_id = EXCLUDED.ultima_movimentacao_id,
            atualizado_em = EXCLUDED.atualizado_em;
    END IF;
  END LOOP;
END $$;

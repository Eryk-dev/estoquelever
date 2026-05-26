-- Voltar origem_id e pedido_id em siso_movimentacoes pra TEXT.
--
-- Bug-raiz: migration 20260520b converteu origem_id de text → uuid
-- "porque a tabela estava vazia". Mas siso_pedidos.id é TEXT (numeric-
-- string vinda do Tiny ERP). Todos os callers de wms_reservar_atomico
-- (webhook-processor-wms, cutover, aprovar/route.ts) passam pedido.id
-- (text) como p_pedido_id (uuid) → erro "invalid input syntax for type
-- uuid".
--
-- Bug latente desde 2026-05-20 — só ficou visível agora porque desde o
-- cutover (25/05) nenhum pedido tinha saldo, e portanto reservarAtomico
-- nunca era chamado em prod.
--
-- Solução: text-back. siso_pedidos.id é text, então origem_id (que
-- recebe pedido_id no contexto de R) e pedido_id em siso_movimentacoes
-- precisam ser text. UUIDs continuam sendo aceitos (auto-cast).

BEGIN;

-- 1. Drop index dependente
DROP INDEX IF EXISTS idx_mov_origem;

-- 2. ALTER COLUMN type
ALTER TABLE siso_movimentacoes
  ALTER COLUMN origem_id TYPE text USING origem_id::text,
  ALTER COLUMN pedido_id TYPE text USING pedido_id::text;

-- 3. Recriar index
CREATE INDEX idx_mov_origem ON siso_movimentacoes (origem_tipo, origem_id);

-- 4. Recriar wms_inserir_movimentacao com p_origem_id text + p_pedido_id text
CREATE OR REPLACE FUNCTION public.wms_inserir_movimentacao(
  p_produto_id            uuid,
  p_galpao_id             uuid,
  p_localizacao_id        uuid,
  p_tipo                  character,
  p_quantidade            numeric,
  p_origem_tipo           text,
  p_origem_id             text DEFAULT NULL,
  p_origem_detalhes       jsonb DEFAULT NULL,
  p_usuario_id            uuid DEFAULT NULL,
  p_expira_em             timestamptz DEFAULT NULL,
  p_estorno_de            uuid DEFAULT NULL,
  p_empresa_compradora_id uuid DEFAULT NULL,
  p_empresa_vendedora_id  uuid DEFAULT NULL,
  p_empresa_referencia_id uuid DEFAULT NULL,
  p_fornecedor_id         uuid DEFAULT NULL,
  p_motivo                text DEFAULT NULL,
  p_cliente_nome          text DEFAULT NULL,
  p_pedido_id             text DEFAULT NULL,
  p_nota_fiscal_id        uuid DEFAULT NULL,
  p_chave_acesso_nf       text DEFAULT NULL,
  p_custo_unitario        numeric DEFAULT NULL
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

  v_recalcula_custo := (p_tipo = 'E' AND p_custo_unitario IS NOT NULL
                        AND p_origem_tipo IN ('nf_compra','devolucao_cliente_integra','lancamento_retroativo'));

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

-- 5. Recriar wms_reservar_atomico com p_pedido_id text
CREATE OR REPLACE FUNCTION public.wms_reservar_atomico(
  p_produto_id     uuid,
  p_galpao_id      uuid,
  p_localizacao_id uuid,
  p_quantidade     numeric,
  p_pedido_id      text,
  p_ttl_horas      integer DEFAULT 48,
  p_usuario_id     uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE v_mov_id uuid;
BEGIN
  v_mov_id := wms_inserir_movimentacao(
    p_produto_id, p_galpao_id, p_localizacao_id,
    'R', p_quantidade, 'reserva_pedido',
    p_origem_id := p_pedido_id,
    p_pedido_id := p_pedido_id,
    p_usuario_id := p_usuario_id,
    p_expira_em := now() + (p_ttl_horas || ' hours')::interval
  );
  RETURN v_mov_id;
END;
$function$;

-- 6. Dropar as versões UUID antigas (criadas pelo 20260520b).
-- CREATE OR REPLACE com tipos diferentes cria overload, não substitui —
-- ambiguidade quebra o RPC call via PostgREST com "function not unique".

DROP FUNCTION IF EXISTS public.wms_reservar_atomico(
  uuid, uuid, uuid, numeric, uuid, integer, uuid
);

DROP FUNCTION IF EXISTS public.wms_inserir_movimentacao(
  uuid, uuid, uuid, character, numeric, text,
  uuid, jsonb, uuid, timestamptz, uuid,
  uuid, uuid, uuid, uuid, text, text,
  uuid, uuid, text, numeric
);

COMMIT;

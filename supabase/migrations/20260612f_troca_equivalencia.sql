-- Cross → Troca de Equivalência (plano 2026-06-12-cross-troca-equivalencia)
--
-- Fundação do fluxo de troca de peça equivalente integrado a pedidos/
-- separação/compras/estoque:
--   1. tier_qualidade em siso_produtos (escala única ordenada — D5)
--   2. siso_equivalencias_verificadas (curadoria humana de pares — D9)
--   3. siso_trocas_equivalencia (solicitação de troca, entidade única — 3 superfícies)
--   4. colunas de substituto em siso_pedido_itens (produto FÍSICO ≠ produto fiscal — D3)
--   5. origem_tipo: +reserva_troca, +liberacao_troca (R forte ao solicitar — D6)
--   6. RPCs atômicas: wms_aprovar_troca_atomico / wms_encerrar_troca_atomico
--   7. grant vendas.aprovar_troca pra role admin (D4)

BEGIN;

-- ── 1. Classificação de qualidade (escala única ordenada) ────────────────────
ALTER TABLE siso_produtos
  ADD COLUMN IF NOT EXISTS tier_qualidade text
  CHECK (tier_qualidade IN ('original', 'primeira_linha', 'segunda_linha'));
-- NULL = sem classificação → toda troca envolvendo o produto exige aprovação.

-- ── 2. Curadoria de pares (auto-troca SÓ com par verificado — D9) ────────────
-- Par normalizado sku_a < sku_b (mesmo padrão de siso_produto_links).
-- status='bloqueado' = override "nunca trocar" mesmo que o cluster OEM diga
-- equivalente.
CREATE TABLE IF NOT EXISTS siso_equivalencias_verificadas (
  id bigserial PRIMARY KEY,
  sku_a text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  sku_b text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'verificado' CHECK (status IN ('verificado', 'bloqueado')),
  observacao text,
  verificado_por uuid REFERENCES siso_usuarios(id),
  verificado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (sku_a < sku_b),
  UNIQUE (sku_a, sku_b)
);

-- ── 3. Solicitação de troca (entidade única, 3 superfícies) ──────────────────
CREATE TABLE IF NOT EXISTS siso_trocas_equivalencia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id text NOT NULL REFERENCES siso_pedidos(id),
  -- ⚠ siso_pedido_itens.id é BIGINT (docs/database-schema.md dizia uuid — stale)
  pedido_item_id bigint NOT NULL REFERENCES siso_pedido_itens(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  produto_vendido_id uuid NOT NULL REFERENCES siso_produtos(id),
  produto_substituto_id uuid NOT NULL REFERENCES siso_produtos(id),
  sku_vendido text NOT NULL,
  sku_substituto text NOT NULL,
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  tipo text NOT NULL CHECK (tipo IN (
    'mesmo_nivel', 'upgrade', 'downgrade', 'sem_classificacao', 'misto'
  )),
  origem_solicitacao text NOT NULL CHECK (origem_solicitacao IN (
    'roteamento', 'separacao', 'compras', 'painel'
  )),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente', 'aprovada', 'rejeitada', 'expirada', 'cancelada'
  )),
  tier_vendido_snapshot text,
  tier_substituto_snapshot text,
  -- R(s) origem_tipo='reserva_troca' criadas no substituto AO SOLICITAR (D6).
  reserva_mov_ids uuid[],
  solicitado_por uuid REFERENCES siso_usuarios(id),
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  decidido_por uuid REFERENCES siso_usuarios(id),
  decidido_em timestamptz,
  motivo_rejeicao text,
  CHECK (produto_vendido_id <> produto_substituto_id)
);

-- Uma troca pendente por item — segunda solicitação exige decidir a primeira.
CREATE UNIQUE INDEX IF NOT EXISTS siso_trocas_equivalencia_pendente_por_item
  ON siso_trocas_equivalencia (pedido_item_id) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS siso_trocas_equivalencia_status_idx
  ON siso_trocas_equivalencia (status, solicitado_em DESC);
CREATE INDEX IF NOT EXISTS siso_trocas_equivalencia_pedido_idx
  ON siso_trocas_equivalencia (pedido_id);

-- ── 4. Substituto no item (produto FÍSICO; produto_id/tiny fica intocado) ────
ALTER TABLE siso_pedido_itens
  ADD COLUMN IF NOT EXISTS produto_wms_substituto_id uuid REFERENCES siso_produtos(id),
  ADD COLUMN IF NOT EXISTS troca_equivalencia_id uuid REFERENCES siso_trocas_equivalencia(id);

-- ── 5. origem_tipo: +reserva_troca, +liberacao_troca ─────────────────────────
-- reserva_troca NÃO usa 'reserva_pedido' de propósito: o cutover
-- (execution-worker) converte toda R reserva_pedido do pedido em L+S — uma
-- troca ainda não aprovada não pode ser consumida pelo lançamento de estoque.
ALTER TABLE siso_movimentacoes DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;
ALTER TABLE siso_movimentacoes ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo = ANY (ARRAY[
    'nf_compra','devolucao_cliente_integra','devolucao_cliente_avariada',
    'devolucao_cliente_troca_sku','devolucao_fornecedor_recebida',
    'devolucao_fornecedor_enviada','nf_venda','venda_manual','ajuste_manual',
    'ajuste_pick_zerou','inventario_perda','inventario_ganho','inventario_inicial',
    'transferencia_galpao','transferencia_localizacao','reserva_pedido',
    'liberacao_reserva','lancamento_retroativo','estorno',
    'reserva_guarda','liberacao_guarda',
    'reserva_troca','liberacao_troca'
  ]::text[]));

-- ── 6a. wms_aprovar_troca_atomico ────────────────────────────────────────────
-- Converte as R de troca (reserva_troca) em R de pedido (reserva_pedido) e
-- aplica o substituto no item — tudo-ou-nada. O par L+R por tripla é seguro:
-- wms_inserir_movimentacao trava a linha de siso_estoque (FOR UPDATE) e o
-- lock persiste até o COMMIT da função inteira — ninguém consome o disponivel
-- entre a liberação e a re-reserva.
CREATE OR REPLACE FUNCTION public.wms_aprovar_troca_atomico(
  p_troca_id uuid,
  p_usuario_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_troca RECORD;
  v_r RECORD;
  v_nova_r uuid;
  v_novas uuid[] := '{}';
  v_convertidas int := 0;
BEGIN
  SELECT * INTO v_troca
    FROM siso_trocas_equivalencia
   WHERE id = p_troca_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TROCA_NAO_ENCONTRADA';
  END IF;
  IF v_troca.status <> 'pendente' THEN
    RAISE EXCEPTION 'TROCA_NAO_PENDENTE:%', v_troca.status;
  END IF;

  -- Converte cada R de troca VIVA (sem L apontando) em R de pedido.
  FOR v_r IN
    SELECT m.*
      FROM siso_movimentacoes m
     WHERE m.id = ANY (COALESCE(v_troca.reserva_mov_ids, '{}'::uuid[]))
       AND m.tipo = 'R'
       AND NOT EXISTS (
         SELECT 1 FROM siso_movimentacoes l
          WHERE l.tipo = 'L' AND l.estorno_de = m.id
       )
  LOOP
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id,
      p_galpao_id := v_r.galpao_id,
      p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'L'::char(1),
      p_quantidade := v_r.quantidade,
      p_origem_tipo := 'liberacao_troca'::text,
      p_origem_id := p_troca_id::text,
      p_origem_detalhes := jsonb_build_object('contexto', 'aprovacao_troca'),
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := v_r.id,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := 'troca equivalência aprovada — converte reserva',
      p_cliente_nome := NULL::text,
      p_pedido_id := v_troca.pedido_id,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    );
    SELECT wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id,
      p_galpao_id := v_r.galpao_id,
      p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'R'::char(1),
      p_quantidade := v_r.quantidade,
      p_origem_tipo := 'reserva_pedido'::text,
      p_origem_id := v_troca.pedido_id,
      p_origem_detalhes := jsonb_build_object(
        'contexto', 'troca_equivalencia',
        'troca_id', p_troca_id::text
      ),
      p_usuario_id := p_usuario_id,
      p_expira_em := now() + interval '30 days',
      p_estorno_de := NULL::uuid,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := 'reserva pedido via troca equivalência',
      p_cliente_nome := NULL::text,
      p_pedido_id := v_troca.pedido_id,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    ) INTO v_nova_r;
    v_novas := array_append(v_novas, v_nova_r);
    v_convertidas := v_convertidas + 1;
  END LOOP;

  UPDATE siso_pedido_itens
     SET produto_wms_substituto_id = v_troca.produto_substituto_id,
         troca_equivalencia_id = v_troca.id
   WHERE id = v_troca.pedido_item_id;

  UPDATE siso_trocas_equivalencia
     SET status = 'aprovada',
         decidido_por = p_usuario_id,
         decidido_em = now()
   WHERE id = p_troca_id;

  RETURN jsonb_build_object(
    'ok', true,
    'convertidas', v_convertidas,
    'novas_reservas', to_jsonb(v_novas)
  );
END;
$function$;

-- ── 6b. wms_encerrar_troca_atomico (rejeitar / cancelar / expirar) ───────────
-- Libera as R de troca remanescentes e fecha a solicitação.
CREATE OR REPLACE FUNCTION public.wms_encerrar_troca_atomico(
  p_troca_id uuid,
  p_usuario_id uuid,
  p_status text,
  p_motivo text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_troca RECORD;
  v_r RECORD;
  v_liberadas int := 0;
BEGIN
  IF p_status NOT IN ('rejeitada', 'cancelada', 'expirada') THEN
    RAISE EXCEPTION 'STATUS_INVALIDO:%', p_status;
  END IF;

  SELECT * INTO v_troca
    FROM siso_trocas_equivalencia
   WHERE id = p_troca_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TROCA_NAO_ENCONTRADA';
  END IF;
  IF v_troca.status <> 'pendente' THEN
    RAISE EXCEPTION 'TROCA_NAO_PENDENTE:%', v_troca.status;
  END IF;

  FOR v_r IN
    SELECT m.*
      FROM siso_movimentacoes m
     WHERE m.id = ANY (COALESCE(v_troca.reserva_mov_ids, '{}'::uuid[]))
       AND m.tipo = 'R'
       AND NOT EXISTS (
         SELECT 1 FROM siso_movimentacoes l
          WHERE l.tipo = 'L' AND l.estorno_de = m.id
       )
  LOOP
    PERFORM wms_inserir_movimentacao(
      p_produto_id := v_r.produto_id,
      p_galpao_id := v_r.galpao_id,
      p_localizacao_id := v_r.localizacao_id,
      p_tipo := 'L'::char(1),
      p_quantidade := v_r.quantidade,
      p_origem_tipo := 'liberacao_troca'::text,
      p_origem_id := p_troca_id::text,
      p_origem_detalhes := jsonb_build_object('contexto', 'encerramento_troca', 'status', p_status),
      p_usuario_id := p_usuario_id,
      p_expira_em := NULL::timestamptz,
      p_estorno_de := v_r.id,
      p_empresa_compradora_id := NULL::uuid,
      p_empresa_vendedora_id := NULL::uuid,
      p_empresa_referencia_id := NULL::uuid,
      p_fornecedor_id := NULL::uuid,
      p_motivo := COALESCE(p_motivo, 'troca equivalência ' || p_status),
      p_cliente_nome := NULL::text,
      p_pedido_id := v_troca.pedido_id,
      p_nota_fiscal_id := NULL::uuid,
      p_chave_acesso_nf := NULL::text,
      p_custo_unitario := NULL::numeric
    );
    v_liberadas := v_liberadas + 1;
  END LOOP;

  UPDATE siso_trocas_equivalencia
     SET status = p_status,
         decidido_por = p_usuario_id,
         decidido_em = now(),
         motivo_rejeicao = p_motivo
   WHERE id = p_troca_id;

  RETURN jsonb_build_object('ok', true, 'reservas_liberadas', v_liberadas);
END;
$function$;

-- ── 7. RBAC: vendas.aprovar_troca pra admin (demais roles via UI de roles) ───
INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
SELECT r.id, 'vendas.aprovar_troca'
FROM siso_roles r
WHERE r.codigo = 'admin'
ON CONFLICT (role_id, permissao_codigo) DO NOTHING;

COMMIT;

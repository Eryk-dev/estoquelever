-- P130/P129/P131 — Confirmar item de embalagem de forma atômica + idempotente.
--
-- Substitui o read-modify-write em confirmar-item-embalagem/route.ts (lost
-- update sob concorrência) por uma RPC plpgsql que:
--   (1) sob FOR UPDATE da linha do item, soma o delta clampado em >=0 (P130);
--   (2) deduplica por client_request_id numa janela de 60s — cobre tanto a
--       janela de 60s (P129/embalagem) quanto <1s (P131/confirmar) porque a
--       janela maior contém a menor (P129).
--
-- supabase-js não tem transação multi-statement client-side: a soma + dedup
-- na mesma transação implícita da função é o que garante atomicidade.

CREATE TABLE IF NOT EXISTS siso_idempotencia_embalagem (
  client_request_id uuid PRIMARY KEY,
  item_id           bigint NOT NULL,
  quantidade_bipada integer NOT NULL,
  bipado_completo   boolean NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idem_embalagem_criado_em
  ON siso_idempotencia_embalagem(criado_em);

CREATE OR REPLACE FUNCTION wms_confirmar_item_embalagem_atomico(
  p_item_id bigint,
  p_delta integer,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_qtd_pedida   numeric;
  v_nova_bipada  integer;
  v_completo     boolean;
  v_existente    siso_idempotencia_embalagem%ROWTYPE;
BEGIN
  -- Dedup: se a chave já foi vista em <60s, retorna o estado registrado sem
  -- reaplicar o delta (idempotência contra duplo-clique/retry de rede).
  SELECT * INTO v_existente
    FROM siso_idempotencia_embalagem
    WHERE client_request_id = p_client_request_id
      AND criado_em > now() - interval '60 seconds';
  IF FOUND THEN
    RETURN jsonb_build_object(
      'quantidade_bipada', v_existente.quantidade_bipada,
      'bipado_completo', v_existente.bipado_completo,
      'deduplicado', true
    );
  END IF;

  -- Lock pessimista da linha + soma atômica clampada em >=0.
  SELECT quantidade_pedida INTO v_qtd_pedida
    FROM siso_pedido_itens
    WHERE id = p_item_id
    FOR UPDATE;
  IF v_qtd_pedida IS NULL THEN
    RAISE EXCEPTION 'item % nao encontrado', p_item_id;
  END IF;

  UPDATE siso_pedido_itens
    SET quantidade_bipada = GREATEST(0, COALESCE(quantidade_bipada, 0) + p_delta),
        bipado_completo = GREATEST(0, COALESCE(quantidade_bipada, 0) + p_delta) >= v_qtd_pedida
    WHERE id = p_item_id
    RETURNING quantidade_bipada, bipado_completo INTO v_nova_bipada, v_completo;

  -- Registra a chave pra dedup futuro. ON CONFLICT cobre a corrida em que
  -- duas chamadas com a MESMA chave passam o SELECT acima quase juntas — a
  -- segunda colide no PK e cai no ramo de já-aplicado.
  BEGIN
    INSERT INTO siso_idempotencia_embalagem
      (client_request_id, item_id, quantidade_bipada, bipado_completo)
    VALUES (p_client_request_id, p_item_id, v_nova_bipada, v_completo);
  EXCEPTION WHEN unique_violation THEN
    -- Outra tx com a mesma chave venceu o INSERT depois de já ter aplicado o
    -- delta dela. Esta tx já aplicou o seu — desfaz o efeito desta lendo o
    -- valor consolidado e retornando-o (não há reaplicação visível ao caller).
    SELECT quantidade_bipada, bipado_completo INTO v_nova_bipada, v_completo
      FROM siso_idempotencia_embalagem WHERE client_request_id = p_client_request_id;
    RAISE EXCEPTION 'client_request_id % ja aplicado', p_client_request_id
      USING ERRCODE = '40001';
  END;

  RETURN jsonb_build_object(
    'quantidade_bipada', v_nova_bipada,
    'bipado_completo', v_completo,
    'deduplicado', false
  );
END;
$$;

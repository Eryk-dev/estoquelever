-- Encaixotar DIA INTEIRO — atalho da pista FUTURA quando a onda é de UM dia só.
--
-- O encaixotamento por bip (wms_encaixotar_atomico) existe pra DISTRIBUIR um
-- carrinho misto (vários dias) entre as caixas = dia de despacho. Quando o
-- operador separou um ÚNICO dia (filtro "Dias" com 1 dia), só existe UMA caixa
-- — não há "qual caixa", então bipar item a item é fricção pura. Esta RPC fecha
-- o dia inteiro de uma vez: deposita a qty restante de TODOS os itens dos
-- pedidos futura já separados daquele dia e fecha (encaixotado_em) os 100%.
--
-- Mesmo efeito de bipar tudo, sem o bip. NÃO muda status_separacao (segue
-- 'separado'; quem avança é a promoção da etiqueta). Idempotente (re-rodar não
-- passa do alvo). Devolve as alocações no MESMO shape do bipar pra reusar o undo
-- (wms_desencaixotar_atomico).

BEGIN;

CREATE OR REPLACE FUNCTION wms_encaixotar_dia_atomico(
  p_dia text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_sem boolean := (p_dia = 'sem');
  v_item record;
  v_alocar integer;
  v_alocacoes jsonb := '[]'::jsonb;
BEGIN
  IF p_dia IS NULL OR trim(p_dia) = '' THEN
    RAISE EXCEPTION 'dia_invalido' USING ERRCODE = '22023';
  END IF;

  -- Varre os itens de pedidos FUTURA já separados do DIA pedido (DATE de
  -- prazo_envio no fuso de SP; 'sem' = sem prazo) que ainda falta encaixotar.
  -- FOR UPDATE serializa com bips concorrentes do mesmo SKU.
  FOR v_item IN
    SELECT pi.id,
           pi.pedido_id,
           COALESCE(pi.quantidade_pega, pi.quantidade_pedida) AS alvo,
           COALESCE(pi.quantidade_encaixotada, 0)             AS feito,
           p.prazo_envio,
           p.numero
    FROM siso_pedido_itens pi
    JOIN siso_pedidos p ON p.id = pi.pedido_id
    WHERE p.separacao_futura = true
      AND p.status_separacao = 'separado'
      AND COALESCE(pi.quantidade_pega, pi.quantidade_pedida) > COALESCE(pi.quantidade_encaixotada, 0)
      AND (
        (v_sem AND p.prazo_envio IS NULL)
        OR (NOT v_sem AND p.prazo_envio IS NOT NULL
            AND to_char((p.prazo_envio AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') = p_dia)
      )
    FOR UPDATE OF pi
  LOOP
    v_alocar := v_item.alvo - v_item.feito;
    IF v_alocar <= 0 THEN CONTINUE; END IF;

    UPDATE siso_pedido_itens
      SET quantidade_encaixotada = v_item.alvo
      WHERE id = v_item.id;

    v_alocacoes := v_alocacoes || jsonb_build_object(
      'pedido_id', v_item.pedido_id,
      'pedido_item_id', v_item.id,
      'numero', v_item.numero,
      'prazo_envio', v_item.prazo_envio,
      'dia', CASE WHEN v_item.prazo_envio IS NULL THEN NULL
                  ELSE to_char((v_item.prazo_envio AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') END,
      'qty', v_alocar
    );
  END LOOP;

  -- Fecha (encaixotado_em) os pedidos que ficaram 100% encaixotados.
  UPDATE siso_pedidos p
    SET encaixotado_em = now()
    WHERE p.encaixotado_em IS NULL
      AND p.id IN (SELECT DISTINCT (e->>'pedido_id') FROM jsonb_array_elements(v_alocacoes) e)
      AND NOT EXISTS (
        SELECT 1 FROM siso_pedido_itens pi
        WHERE pi.pedido_id = p.id
          AND COALESCE(pi.quantidade_pega, pi.quantidade_pedida) > COALESCE(pi.quantidade_encaixotada, 0)
      );

  RETURN jsonb_build_object(
    'dia', p_dia,
    'pedidos', (SELECT COUNT(DISTINCT e->>'pedido_id') FROM jsonb_array_elements(v_alocacoes) e),
    'qty_alocada', (SELECT COALESCE(SUM((e->>'qty')::int), 0) FROM jsonb_array_elements(v_alocacoes) e),
    'alocacoes', v_alocacoes
  );
END;
$$;

COMMIT;

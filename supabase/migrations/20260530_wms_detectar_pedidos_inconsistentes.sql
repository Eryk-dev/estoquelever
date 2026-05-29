-- Fase 2.1 — Safety net de reconciliação do fluxo Pedido→Separação→Estoque.
-- Sinaliza os 3 padrões que a Fase 1 tornou impossíveis daqui pra frente, mas
-- que podem existir em dados históricos (ou reaparecer se uma feature nova
-- reintroduzir um caminho de baixa paralelo):
--   A) item separacao_marcado=true com qty pega mas SEM saída S no ledger
--      (mov_saida_id NULL) → marcou sem baixar.
--   B) pedido FORWARD (separado/embalado/expedido) com saída S nf_venda viva
--      mas pedido.estoque_lancado=false → cutover/flag dessincronizado. O filtro
--      de status forward é ESSENCIAL: a S nasce no pick (status ainda
--      em_separacao/aguardando_separacao) e estoque_lancado só vira true no
--      cutover ao chegar no conjunto forward — então sem o filtro todo pedido
--      em meio de separação (estado transitório normal) seria falso-positivo.
--   C) pedido forward (separado/embalado/expedido) com reserva R ainda viva
--      (sem L estornando) → reserva não foi convertida no pick.
CREATE OR REPLACE FUNCTION public.wms_detectar_pedidos_inconsistentes()
RETURNS TABLE(
  padrao text,
  pedido_id text,
  produto_id text,
  status_separacao text,
  estoque_lancado boolean,
  detalhe text
)
LANGUAGE sql
STABLE
AS $function$
  -- A: marcado sem saída S
  SELECT
    'A_marcado_sem_saida'::text,
    i.pedido_id,
    i.produto_id::text,
    p.status_separacao,
    p.estoque_lancado,
    format('item marcado (qty_pega=%s) sem mov_saida_id', i.quantidade_pega)
  FROM siso_pedido_itens i
  JOIN siso_pedidos p ON p.id = i.pedido_id
  WHERE i.separacao_marcado = true
    AND i.quantidade_pega > 0
    AND i.mov_saida_id IS NULL

  UNION ALL

  -- B: saída S viva com estoque_lancado=false
  SELECT
    'B_saida_sem_estoque_lancado'::text,
    m.pedido_id,
    m.produto_id::text,
    p.status_separacao,
    p.estoque_lancado,
    format('mov S %s (nf_venda) mas pedido.estoque_lancado=false', m.id)
  FROM siso_movimentacoes m
  JOIN siso_pedidos p ON p.id = m.pedido_id
  WHERE m.tipo = 'S'
    AND m.origem_tipo = 'nf_venda'
    AND m.estorno_de IS NULL
    AND p.status_separacao IN ('separado', 'embalado', 'expedido')
    AND COALESCE(p.estoque_lancado, false) = false

  UNION ALL

  -- C: pedido forward com reserva R viva
  SELECT
    'C_forward_com_reserva_viva'::text,
    r.pedido_id,
    r.produto_id::text,
    p.status_separacao,
    p.estoque_lancado,
    format('reserva R %s ainda viva em pedido %s', r.id, p.status_separacao)
  FROM siso_movimentacoes r
  JOIN siso_pedidos p ON p.id = r.pedido_id
  WHERE r.tipo = 'R'
    AND r.origem_tipo = 'reserva_pedido'
    AND p.status_separacao IN ('separado', 'embalado', 'expedido')
    AND NOT EXISTS (
      SELECT 1 FROM siso_movimentacoes l
      WHERE l.tipo = 'L' AND l.estorno_de = r.id
    );
$function$;

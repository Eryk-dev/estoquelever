-- Separação Futura — pré-carregar vendas ML com etiqueta segurada (buffered).
--
-- Flag boolean (decisão: reusar status_separacao, não criar estados futura_*).
-- A pista futura vive em /wms/separacao-futura, filtrada por esta flag, e usa os
-- mesmos status_separacao do fluxo normal: aguardando_compra → aguardando_separacao
-- → em_separacao → separado (PARA aqui; promoção flipa a flag p/ false e segue o
-- fluxo normal de NF/embalagem).
--
-- Pedido normal continua false. A promoção (etiqueta liberou) seta de volta false.

ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS separacao_futura boolean NOT NULL DEFAULT false;

-- Índice parcial: a fila futura é uma fração pequena dos pedidos; só indexamos as
-- linhas true (a fila normal já tem seus próprios índices por status_separacao).
CREATE INDEX IF NOT EXISTS idx_pedidos_separacao_futura
  ON siso_pedidos (status_separacao)
  WHERE separacao_futura = true;

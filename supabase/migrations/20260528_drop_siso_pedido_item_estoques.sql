-- Fase 1.4 — DROP do snapshot estale siso_pedido_item_estoques.
-- Todos os ~13 consumidores (leitores + escritores) foram migrados pra ler
-- estoque VIVO de siso_estoque / da R viva do ledger (grep .from()=0 confirmado).
-- Sem views, FK inbound ou triggers dependentes. O snapshot congelado era a
-- raiz do loop de OC (pedido 937933727) e da loc-de-pick errada (pedido 937979990).
DROP TABLE IF EXISTS siso_pedido_item_estoques;

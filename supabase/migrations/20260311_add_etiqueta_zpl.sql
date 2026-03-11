-- Cache ZPL label content at separation time so that at packing time
-- we skip Tiny API calls and send directly to PrintNode (~instant print).
-- ZPL is plain text, typically 2-10KB per label — safe to store in text column.
ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS etiqueta_zpl text;

COMMENT ON COLUMN siso_pedidos.etiqueta_zpl
  IS 'Raw ZPL content of the shipping label, pre-fetched at separation conclusion';

-- ============================================================
-- Migration: Add PrintNode printer config to galpoes and usuarios
-- Stores configured PrintNode printer per galpão (default)
-- and optional per-user override.
-- ============================================================

ALTER TABLE siso_galpoes
  ADD COLUMN printnode_printer_id bigint,
  ADD COLUMN printnode_printer_nome text;

ALTER TABLE siso_usuarios
  ADD COLUMN printnode_printer_id bigint,
  ADD COLUMN printnode_printer_nome text;

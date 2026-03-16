-- Add cargos array column to support multiple roles per user
ALTER TABLE siso_usuarios ADD COLUMN IF NOT EXISTS cargos text[] NOT NULL DEFAULT '{}';

-- Populate from existing cargo column
UPDATE siso_usuarios SET cargos = ARRAY[cargo] WHERE cargos = '{}';

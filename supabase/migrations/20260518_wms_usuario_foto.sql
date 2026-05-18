-- WMS — Avatar de usuário (foto exibida no card da party do inventário).
--
-- Idempotente. Cria:
--  - siso_usuarios.foto_url (URL pública pra imagem)
--  - storage.buckets row 'avatars' (público, 2MB, formatos comuns)
--  - 2 policies: leitura pública + escrita autenticada (mas escrita real
--    passa pelo endpoint server-side com service role).

BEGIN;

ALTER TABLE siso_usuarios
  ADD COLUMN IF NOT EXISTS foto_url text;

COMMENT ON COLUMN siso_usuarios.foto_url IS
  'URL pública do avatar do usuário (bucket "avatars"). NULL = exibe iniciais.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 'avatars', true, 2097152,
  ARRAY['image/png','image/jpeg','image/jpg','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = ARRAY['image/png','image/jpeg','image/jpg','image/webp','image/gif'];

DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_authenticated_write" ON storage.objects;
CREATE POLICY "avatars_authenticated_write" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars');

COMMIT;

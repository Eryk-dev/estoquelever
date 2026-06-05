-- P138/P139 — Replace atômico das permissões de um role.
--
-- A rota fazia delete+insert em duas chamadas client-side (sem transação): se
-- o insert falhava após o delete, o role ficava sem permissões (P138). E dois
-- PUTs concorrentes intercalavam delete/insert → last-write-wins (P139).
--
-- supabase-js não tem transação multi-statement client-side. Esta função faz,
-- na sua transação implícita:
--   (1) SELECT ... FOR UPDATE da row do role — serializa edições concorrentes
--       (P139: o 2º admin espera o 1º terminar e re-aplica de forma serializada).
--   (2) DELETE de todas as permissões + INSERT das novas — atômico (P138).
-- Qualquer RAISE → rollback total: as permissões pré-existentes permanecem.

CREATE OR REPLACE FUNCTION wms_set_role_permissoes(
  p_role_id uuid,
  p_codigos text[]
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id uuid;
  v_total   integer;
BEGIN
  -- Lock pessimista por row: serializa P139. O 2º PUT bloqueia aqui até o 1º
  -- commitar, então re-aplica em cima do estado consistente (sem mesclar).
  SELECT id INTO v_role_id FROM siso_roles WHERE id = p_role_id FOR UPDATE;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'role % nao encontrado', p_role_id;
  END IF;

  DELETE FROM siso_role_permissoes WHERE role_id = p_role_id;

  IF array_length(p_codigos, 1) IS NOT NULL THEN
    INSERT INTO siso_role_permissoes (role_id, permissao_codigo)
    SELECT p_role_id, unnest(p_codigos)
    ON CONFLICT (role_id, permissao_codigo) DO NOTHING;
  END IF;

  SELECT count(*) INTO v_total FROM siso_role_permissoes WHERE role_id = p_role_id;
  RETURN v_total;
END;
$$;

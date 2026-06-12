-- [PERF-T3] Carga de sessão num único round-trip (substitui 2-4 queries).
-- getSessionUser (session.ts) + loadUserRolesAndPermissions (roles-loader.ts)
-- faziam até 4 queries sequenciais por request /api/wms/* num cache miss:
--   1. sessão + usuário   2. usuario_roles → roles → permissões
--   3. fallback de roles por cargos[]   4. validação de galpão
-- Esta RPC consolida tudo. Réplica EXATA da lógica TS — incluindo o fallback
-- de roles por cargos[]/cargo quando o usuário não tem nenhuma role ativa, e a
-- prioridade de galpão (header válido > cargo legado operador_cwb/sp > null).
-- O TS resolve o galpão final: header válido (galpao_valido) tem precedência;
-- senão galpao_cargo_id. Casts inválidos de uuid → NULL (sem erro).
BEGIN;

CREATE OR REPLACE FUNCTION wms_session_load(
  p_session_id text,
  p_galpao_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_sid          uuid;
  v_gid          uuid;
  v_user         record;
  v_roles        jsonb;
  v_permissoes   jsonb;
  v_role_count   int;
  v_codigos      text[];
  v_galpao_valido boolean := false;
  v_galpao_cargo_id uuid := NULL;
  v_op_codigo    text;
  v_galpao_nome  text;
BEGIN
  -- Cast seguro: garbage vira NULL sem estourar erro.
  BEGIN
    v_sid := p_session_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;

  BEGIN
    v_gid := p_galpao_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_gid := NULL;
  END;

  -- 1. Sessão + usuário (sessão viva). Não achou → NULL (cobre sessão inválida
  --    E usuário ausente, igual ao TS original).
  SELECT u.id, u.nome, u.cargo, u.cargos
    INTO v_user
    FROM siso_sessoes s
    JOIN siso_usuarios u ON u.id = s.usuario_id
   WHERE s.id = v_sid
     AND s.expira_em > now();

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 2. Roles ATIVAS via siso_usuario_roles → siso_roles (ativo).
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'codigo', r.codigo, 'nome', r.nome) ORDER BY r.codigo), '[]'::jsonb)
    INTO v_roles
    FROM siso_usuario_roles ur
    JOIN siso_roles r ON r.id = ur.role_id AND r.ativo
   WHERE ur.usuario_id = v_user.id;

  SELECT COALESCE(jsonb_agg(DISTINCT rp.permissao_codigo), '[]'::jsonb)
    INTO v_permissoes
    FROM siso_usuario_roles ur
    JOIN siso_roles r ON r.id = ur.role_id AND r.ativo
    JOIN siso_role_permissoes rp ON rp.role_id = r.id
   WHERE ur.usuario_id = v_user.id;

  v_role_count := jsonb_array_length(v_roles);

  -- 3. Fallback (réplica): 0 roles ativas E (cargos[] não-vazio OU cargo não-nulo)
  --    → busca roles ativas pelos códigos em cargos[] (ou [cargo]).
  IF v_role_count = 0 AND (COALESCE(array_length(v_user.cargos, 1), 0) > 0 OR v_user.cargo IS NOT NULL) THEN
    IF COALESCE(array_length(v_user.cargos, 1), 0) > 0 THEN
      v_codigos := v_user.cargos;
    ELSE
      v_codigos := ARRAY[v_user.cargo];
    END IF;

    SELECT
      COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'codigo', r.codigo, 'nome', r.nome) ORDER BY r.codigo), '[]'::jsonb)
      INTO v_roles
      FROM siso_roles r
     WHERE r.codigo = ANY(v_codigos) AND r.ativo;

    SELECT COALESCE(jsonb_agg(DISTINCT rp.permissao_codigo), '[]'::jsonb)
      INTO v_permissoes
      FROM siso_roles r
      JOIN siso_role_permissoes rp ON rp.role_id = r.id
     WHERE r.codigo = ANY(v_codigos) AND r.ativo;
  END IF;

  -- 4. Validação de galpão (header).
  v_galpao_valido := v_gid IS NOT NULL AND EXISTS (
    SELECT 1 FROM siso_usuario_galpoes
     WHERE usuario_id = v_user.id AND galpao_id = v_gid
  );

  -- 5. Galpão legado por cargo: primeira role (na ordem do array) que casar com
  --    operador_cwb/operador_sp resolve pro galpão de nome CWB/SP.
  SELECT elem->>'codigo' INTO v_op_codigo
    FROM jsonb_array_elements(v_roles) WITH ORDINALITY AS t(elem, ord)
   WHERE elem->>'codigo' IN ('operador_cwb', 'operador_sp')
   ORDER BY ord
   LIMIT 1;

  IF v_op_codigo IS NOT NULL THEN
    v_galpao_nome := CASE WHEN v_op_codigo = 'operador_cwb' THEN 'CWB' ELSE 'SP' END;
    SELECT id INTO v_galpao_cargo_id FROM siso_galpoes WHERE nome = v_galpao_nome LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'usuario', jsonb_build_object(
      'id', v_user.id,
      'nome', v_user.nome,
      'cargo', v_user.cargo,
      'cargos', to_jsonb(v_user.cargos)
    ),
    'roles', v_roles,
    'permissoes', v_permissoes,
    'galpao_valido', v_galpao_valido,
    'galpao_cargo_id', v_galpao_cargo_id
  );
END;
$$;

COMMENT ON FUNCTION wms_session_load(text,text) IS
  '[PERF-T3] Carga de sessão+usuário+roles+permissões+galpão num único round-trip (substitui 2-4 queries de getSessionUser).';

COMMIT;

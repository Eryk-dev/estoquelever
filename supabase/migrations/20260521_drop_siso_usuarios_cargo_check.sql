-- ──────────────────────────────────────────────────────────────────────
-- Drop o CHECK constraint legado em siso_usuarios.cargo.
--
-- Por quê: com o sistema de roles dinâmico em siso_roles (migration
-- 20260521_roles_permissoes), admins criam roles customizadas via UI. O
-- trigger trg_sync_cargos_after_roles escreve o codigo da role direto em
-- siso_usuarios.cargo / cargos[]. Um CHECK estático com lista hardcoded
-- bloqueia qualquer role nova (incluindo 'vendedor', adicionada em
-- 20260519_vendas_diretas_vendedor mas nunca incluída no CHECK).
--
-- Validação agora é via siso_roles (source of truth) + VALID_CARGOS no
-- código (whitelist conservadora pra rotas legadas).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE siso_usuarios DROP CONSTRAINT IF EXISTS siso_usuarios_cargo_check;

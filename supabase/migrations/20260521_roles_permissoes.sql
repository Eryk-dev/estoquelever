-- ──────────────────────────────────────────────────────────────────────
-- Roles & Permissões — substitui controle de acesso baseado em cargos[]
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Schema
create table if not exists siso_roles (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,
  nome          text not null,
  descricao     text,
  sistema       boolean not null default false,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists siso_role_permissoes (
  role_id          uuid not null references siso_roles(id) on delete cascade,
  permissao_codigo text not null,
  primary key (role_id, permissao_codigo)
);

create table if not exists siso_usuario_roles (
  usuario_id uuid not null references siso_usuarios(id) on delete cascade,
  role_id    uuid not null references siso_roles(id) on delete cascade,
  primary key (usuario_id, role_id)
);

create index if not exists siso_role_permissoes_codigo_idx on siso_role_permissoes(permissao_codigo);
create index if not exists siso_usuario_roles_role_idx on siso_usuario_roles(role_id);

-- 2. Seed das 6 roles sistema
insert into siso_roles (codigo, nome, descricao, sistema) values
  ('admin',        'Admin',        'Acesso completo ao sistema',                      true),
  ('operador',     'Operador',     'Operador genérico (todos galpões)',              true),
  ('operador_cwb', 'Operador CWB', 'Operador alocado em CWB',                         true),
  ('operador_sp',  'Operador SP',  'Operador alocado em SP',                          true),
  ('comprador',    'Comprador',    'Acesso ao módulo de compras e relatórios',       true),
  ('vendedor',     'Vendedor',     'Acesso a Vendas Diretas',                         true)
on conflict (codigo) do nothing;

-- 3. Seed das permissões iniciais por role
-- admin: TODAS as 30
with all_perms(p) as (values
  ('vendas.ver'), ('vendas.criar'),
  ('pedidos.ver'), ('pedidos.aprovar'),
  ('separacao.ver'), ('separacao.executar'),
  ('compras.ver'), ('compras.executar'),
  ('estoque.ver'), ('cobertura.ver'),
  ('operacoes.transferir'), ('operacoes.replenishment'),
  ('operacoes.devolucoes'), ('operacoes.receber'),
  ('operacoes.guarda'), ('operacoes.ajuste_manual'),
  ('inventario.ver'), ('inventario.executar'), ('inventario.supervisionar'),
  ('insights.ver'), ('insights.financeiro'), ('insights.regras'),
  ('relatorios.ver'),
  ('produtos.editar'), ('localizacoes.editar'), ('fornecedores.editar'),
  ('sistema.usuarios'), ('sistema.roles'), ('sistema.conexoes'), ('sistema.galpoes_empresas')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p from siso_roles r cross join all_perms where r.codigo = 'admin'
on conflict (role_id, permissao_codigo) do nothing;

-- operador (todos galpões), operador_cwb, operador_sp — mesmo set
with op_perms(p) as (values
  ('vendas.ver'),
  ('pedidos.ver'), ('pedidos.aprovar'),
  ('separacao.ver'), ('separacao.executar'),
  ('compras.ver'),
  ('estoque.ver'), ('cobertura.ver'),
  ('operacoes.transferir'), ('operacoes.replenishment'),
  ('operacoes.devolucoes'), ('operacoes.receber'),
  ('operacoes.guarda'), ('operacoes.ajuste_manual'),
  ('inventario.ver'), ('inventario.executar'),
  ('insights.ver'),
  ('relatorios.ver'),
  ('produtos.editar'), ('localizacoes.editar'), ('fornecedores.editar')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p
from siso_roles r cross join op_perms
where r.codigo in ('operador', 'operador_cwb', 'operador_sp')
on conflict (role_id, permissao_codigo) do nothing;

-- comprador
with comp_perms(p) as (values
  ('pedidos.ver'),
  ('compras.ver'), ('compras.executar'),
  ('estoque.ver'), ('cobertura.ver'),
  ('relatorios.ver')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p from siso_roles r cross join comp_perms where r.codigo = 'comprador'
on conflict (role_id, permissao_codigo) do nothing;

-- vendedor
with vend_perms(p) as (values
  ('vendas.ver'), ('vendas.criar')
)
insert into siso_role_permissoes (role_id, permissao_codigo)
select r.id, p from siso_roles r cross join vend_perms where r.codigo = 'vendedor'
on conflict (role_id, permissao_codigo) do nothing;

-- 4. Backfill siso_usuario_roles a partir de siso_usuarios.cargos[] (ou .cargo)
insert into siso_usuario_roles (usuario_id, role_id)
select u.id, r.id
from siso_usuarios u
cross join lateral unnest(
  case when cardinality(u.cargos) = 0 then ARRAY[u.cargo] else u.cargos end
) c
join siso_roles r on r.codigo = c
on conflict do nothing;

-- 5. Trigger pra manter siso_usuarios.cargos[]/.cargo sincronizado
create or replace function wms_sync_cargos_from_roles() returns trigger as $$
declare v_usuario_id uuid;
begin
  v_usuario_id := coalesce(new.usuario_id, old.usuario_id);
  update siso_usuarios u set
    cargos = coalesce((
      select array_agg(r.codigo order by r.codigo)
      from siso_usuario_roles ur
      join siso_roles r on r.id = ur.role_id
      where ur.usuario_id = v_usuario_id
    ), ARRAY[]::text[]),
    cargo = coalesce((
      select r.codigo
      from siso_usuario_roles ur
      join siso_roles r on r.id = ur.role_id
      where ur.usuario_id = v_usuario_id
      order by case when r.codigo = 'admin' then 0 else 1 end, r.codigo
      limit 1
    ), u.cargo)
  where u.id = v_usuario_id;
  return null;
end; $$ language plpgsql;

drop trigger if exists trg_sync_cargos_after_roles on siso_usuario_roles;
create trigger trg_sync_cargos_after_roles
  after insert or delete on siso_usuario_roles
  for each row execute function wms_sync_cargos_from_roles();

-- 6. RPC pra proteção de delete
create or replace function wms_role_delete(p_role_id uuid) returns void as $$
declare v_sistema boolean; v_codigo text;
begin
  select sistema, codigo into v_sistema, v_codigo from siso_roles where id = p_role_id;
  if not found then
    raise exception 'Role não existe';
  end if;
  if v_sistema then
    raise exception 'Role de sistema não pode ser deletada (codigo=%)', v_codigo;
  end if;
  -- Bloqueia se algum usuário ficaria sem nenhuma role
  if exists (
    select 1 from siso_usuario_roles ur
    where ur.role_id = p_role_id
      and not exists (
        select 1 from siso_usuario_roles ur2
        where ur2.usuario_id = ur.usuario_id and ur2.role_id <> p_role_id
      )
  ) then
    raise exception 'Usuários ficariam sem nenhuma role — atribua outra role antes de deletar';
  end if;
  delete from siso_roles where id = p_role_id;
end; $$ language plpgsql;

-- 7. Trigger pra atualizar atualizado_em
create or replace function siso_roles_touch_atualizado_em() returns trigger as $$
begin new.atualizado_em := now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_siso_roles_touch on siso_roles;
create trigger trg_siso_roles_touch
  before update on siso_roles
  for each row execute function siso_roles_touch_atualizado_em();

COMMIT;

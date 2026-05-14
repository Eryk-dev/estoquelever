-- ─────────────────────────────────────────────────────────────────────
-- Mercado Livre OAuth + cache de anúncios por SKU (multi-conta)
--
-- Modelo:
--   siso_ml_app_config (singleton)  → 1 App do dev (App ID + Client Secret)
--   siso_ml_connections             → N conexões (1 por conta seller do ML)
--   siso_ml_anuncios_cache          → cache de anúncios por (conexão, mlb_id)
--                                     pra resposta rápida no recebimento
--
-- Tokens (access + refresh) ficam em siso_ml_connections. Refresh é
-- single-use no ML: cada renovação devolve novo refresh_token, então
-- precisa ser persistido na mesma transação.
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ─── App config (singleton) ──────────────────────────────────────────

create table if not exists siso_ml_app_config (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  client_secret text not null,
  site_id text not null default 'MLB',
  -- placeholder pro caso de queremos forçar redirect_uri fixo
  redirect_uri text,
  atualizado_em timestamptz not null default now(),
  -- garante linha única (singleton)
  singleton boolean not null default true,
  unique (singleton)
);

comment on table siso_ml_app_config is
  'Credenciais globais do app dev do Mercado Livre. Singleton (1 linha).';

-- ─── Conexões (1 por conta seller ML) ────────────────────────────────

create table if not exists siso_ml_connections (
  id uuid primary key default gen_random_uuid(),
  ml_user_id bigint not null unique,
  nickname text not null,
  email text,
  site_id text not null default 'MLB',
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scope text,
  -- CSRF do fluxo OAuth (limpa após callback)
  oauth_state text,
  -- vínculo opcional pra cada conexão se aderir a uma empresa Tiny do WMS
  -- (útil pra exibir agrupado depois; não bloqueia o salvamento)
  empresa_id uuid references siso_empresas(id) on delete set null,
  ativo boolean not null default true,
  ultimo_sync_em timestamptz,
  ultimo_erro text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

create index if not exists ix_ml_connections_ativo
  on siso_ml_connections (ativo)
  where ativo = true;

comment on table siso_ml_connections is
  'Conta do Mercado Livre autorizada via OAuth2. Suporta N por instalação.';

-- ─── Trigger de atualizada_em ────────────────────────────────────────

create or replace function siso_ml_set_atualizada_em()
returns trigger language plpgsql as $$
begin
  new.atualizada_em := now();
  return new;
end;
$$;

drop trigger if exists tr_ml_connections_set_atualizada_em on siso_ml_connections;
create trigger tr_ml_connections_set_atualizada_em
  before update on siso_ml_connections
  for each row execute function siso_ml_set_atualizada_em();

-- ─── Cache de anúncios por SKU/conexão ───────────────────────────────

create table if not exists siso_ml_anuncios_cache (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references siso_ml_connections(id) on delete cascade,
  sku text not null,
  mlb_id text not null,
  title text not null,
  price numeric(14,2),
  status text,
  permalink text,
  available_quantity int,
  sold_quantity int,
  thumbnail text,
  listing_type_id text,
  -- snapshot bruto pra debugging / inspeção
  raw jsonb,
  atualizado_em timestamptz not null default now(),
  unique (conexao_id, mlb_id)
);

create index if not exists ix_ml_anuncios_sku
  on siso_ml_anuncios_cache (sku);

create index if not exists ix_ml_anuncios_conexao_sku
  on siso_ml_anuncios_cache (conexao_id, sku);

comment on table siso_ml_anuncios_cache is
  'Cache de anúncios ML por SKU. Atualizado on-demand quando o recebimento '
  'consulta anúncios; TTL gerenciado no app (5min).';

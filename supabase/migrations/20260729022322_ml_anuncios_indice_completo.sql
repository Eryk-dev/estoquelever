-- Índice exaustivo de anúncios ativos do Mercado Livre.
--
-- O scan roda em páginas assíncronas via pg_cron. Cada conta mantém uma
-- geração em construção e uma geração concluída. O relatório só usa a geração
-- concluída, então uma interrupção ou scroll expirado nunca publica snapshot
-- parcial como se fosse completo.
--
-- A rota usa service_role pelo backend. As tabelas ficam fechadas para
-- anon/authenticated e com RLS habilitado.

create table if not exists public.siso_ml_anuncios_scan_state (
  conexao_id uuid primary key
    references public.siso_ml_connections(id) on delete cascade,
  status text not null default 'idle'
    check (status in ('idle', 'scanning', 'completed', 'error')),
  scan_generation uuid,
  scroll_id text,
  scroll_tocado_em timestamptz,
  busca_em_andamento boolean not null default false,
  pagina_pendente_ids text[],
  pagina_pendente_final boolean not null default false,
  paginas_processadas integer not null default 0
    check (paginas_processadas >= 0),
  itens_processados integer not null default 0
    check (itens_processados >= 0),
  iniciado_em timestamptz,
  ultima_geracao_concluida uuid,
  ultima_varredura_completa_em timestamptz,
  ultimo_total_itens integer
    check (ultimo_total_itens is null or ultimo_total_itens >= 0),
  ultimo_erro text,
  lease_token uuid,
  lease_ate timestamptz,
  atualizado_em timestamptz not null default now()
);

comment on table public.siso_ml_anuncios_scan_state is
  'Checkpoint por conta do scan completo de anúncios ativos ML. '
  'ultima_geracao_concluida só muda após todas as páginas serem indexadas.';

create index if not exists ix_ml_anuncios_scan_pendentes
  on public.siso_ml_anuncios_scan_state (status, atualizado_em);

create table if not exists public.siso_ml_anuncios_indice_completo (
  conexao_id uuid not null
    references public.siso_ml_connections(id) on delete cascade,
  scan_generation uuid not null,
  sku_normalizado text not null,
  sku_original text not null,
  mlb_id text not null,
  registrado_em timestamptz not null default now(),
  primary key (conexao_id, scan_generation, sku_normalizado, mlb_id)
);

comment on table public.siso_ml_anuncios_indice_completo is
  'SKUs de anúncios ativos ML, incluindo SKU no item e em variations[]. '
  'Somente gerações apontadas por scan_state.ultima_geracao_concluida '
  'podem provar ausência no relatório.';

create index if not exists ix_ml_anuncios_indice_sku
  on public.siso_ml_anuncios_indice_completo
    (sku_normalizado, conexao_id, scan_generation);

alter table public.siso_ml_anuncios_scan_state enable row level security;
alter table public.siso_ml_anuncios_indice_completo enable row level security;

revoke all on table public.siso_ml_anuncios_scan_state
  from anon, authenticated;
revoke all on table public.siso_ml_anuncios_indice_completo
  from anon, authenticated;
grant select, insert, update, delete
  on table public.siso_ml_anuncios_scan_state to service_role;
grant select, insert, update, delete
  on table public.siso_ml_anuncios_indice_completo to service_role;

-- Mesmo padrão dos demais workers HTTP do projeto.
DO $$
DECLARE
  v_jobid integer;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'wms_ml_anuncios_indice_completo'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wms_ml_anuncios_indice_completo',
  '* * * * *',
  $cron$
    SELECT net.http_get(
      url := 'https://estoquelever.vercel.app/api/wms/ml/anuncios-indexar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'worker_secret'
          LIMIT 1
        )
      ),
      timeout_milliseconds := 180000
    );
  $cron$
);

-- Rollback operacional:
--   SELECT cron.unschedule('wms_ml_anuncios_indice_completo');
--   DROP TABLE public.siso_ml_anuncios_indice_completo;
--   DROP TABLE public.siso_ml_anuncios_scan_state;

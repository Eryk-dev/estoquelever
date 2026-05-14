-- Lease lock pra serializar refresh do token ML por conexão.
-- Necessário pq refresh_token é single-use no ML: se 2 processos refreshem
-- em paralelo, o 2º vai usar um refresh_token que já foi rotacionado e
-- vai falhar (matando a conexão).
alter table siso_ml_connections
  add column if not exists refreshing_at timestamptz;

comment on column siso_ml_connections.refreshing_at is
  'Lease lock: timestamp de quando o refresh foi reivindicado. Outro processo deve esperar ou tentar claim de novo após TTL de 30s.';

create index if not exists ix_ml_connections_refreshing
  on siso_ml_connections (refreshing_at)
  where refreshing_at is not null;

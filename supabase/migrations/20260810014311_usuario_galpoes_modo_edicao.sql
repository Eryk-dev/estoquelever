alter table public.siso_usuario_galpoes
  add column if not exists pode_editar boolean not null default true;

comment on column public.siso_usuario_galpoes.pode_editar is
  'true: usuário pode alterar dados do galpão; false: acesso somente para visualização.';

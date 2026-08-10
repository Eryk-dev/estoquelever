alter table public.siso_pedidos
  add column if not exists full_etiqueta_zpl_original text,
  add column if not exists full_etiqueta_zpl_ordenada text,
  add column if not exists full_etiqueta_total integer,
  add column if not exists full_etiqueta_anexada_em timestamptz,
  add column if not exists full_etiqueta_anexada_por uuid references public.siso_usuarios(id);

comment on column public.siso_pedidos.full_etiqueta_zpl_original is
  'Arquivo ZPL original do Mercado Livre anexado ao envio Full.';
comment on column public.siso_pedidos.full_etiqueta_zpl_ordenada is
  'Mesmo ZPL reordenado pela localização WMS após confirmação explícita da ordem.';

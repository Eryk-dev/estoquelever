-- Aba "Cancelados" na separação: pedidos cancelados (cliente OU comprador OU
-- operador) deixam de sumir — passam a aparecer numa aba após "Conferidos" com
-- motivo + origem do cancelamento.
--
-- Mantém o caminho atual (status='cancelado' + status_separacao=null): a aba é
-- VIRTUAL (filtra status='cancelado'), sem novo valor em status_separacao — não
-- toca CHECK constraint, cutover nem voltar-etapa.

alter table siso_pedidos
  add column if not exists motivo_cancelamento text,
  add column if not exists cancelado_origem text,
  add column if not exists cancelado_em timestamptz;

comment on column siso_pedidos.cancelado_origem is
  'Origem do cancelamento (aba Cancelados): cliente | comprador | operador | sistema';
comment on column siso_pedidos.motivo_cancelamento is
  'Motivo livre do cancelamento exibido na aba Cancelados da separação';
comment on column siso_pedidos.cancelado_em is
  'Momento do cancelamento (ordena a aba Cancelados, mais recente primeiro)';

-- Limpeza: pedidos cancelados que ficaram com status_separacao não-nulo vazam
-- nas abas normais (em_separacao/embalado). Normaliza pra NULL (estado correto).
update siso_pedidos
   set status_separacao = null
 where status = 'cancelado' and status_separacao is not null;

-- Backfill best-effort dos cancelados existentes.
--   cancelado_em      ← processado_em
--   cancelado_origem  ← histórico (compra_* = comprador · webhook = cliente · senão operador)
--   motivo_cancelamento ← junção dos motivos dos itens de compra cancelados (quando houver)
update siso_pedidos p set
  cancelado_em = coalesce(p.cancelado_em, p.processado_em),
  cancelado_origem = coalesce(
    p.cancelado_origem,
    case
      when exists (
        select 1 from siso_pedido_historico h
        where h.pedido_id::text = p.id
          and h.evento in ('compra_item_cancelado', 'compra_pedido_cancelado')
      ) then 'comprador'
      when exists (
        select 1 from siso_pedido_historico h
        where h.pedido_id::text = p.id
          and h.evento = 'cancelado'
          and (h.detalhes->>'origem') = 'webhook_cancelamento'
      ) then 'cliente'
      else 'operador'
    end
  ),
  motivo_cancelamento = coalesce(
    p.motivo_cancelamento,
    (
      select string_agg(distinct i.compra_cancelamento_motivo, ' · ')
        from siso_pedido_itens i
       where i.pedido_id::text = p.id
         and i.compra_cancelamento_motivo is not null
    )
  )
where p.status = 'cancelado';

-- Rótulo genérico pro cancelamento do cliente (Tiny não manda motivo).
update siso_pedidos
   set motivo_cancelamento = 'Cancelado pelo cliente (marketplace)'
 where status = 'cancelado'
   and cancelado_origem = 'cliente'
   and motivo_cancelamento is null;

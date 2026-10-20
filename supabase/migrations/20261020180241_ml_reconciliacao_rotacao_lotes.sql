-- Rodízio: pedidos nunca verificados primeiro; depois, a consulta mais antiga.
-- next_check_at limita a frequência, sem deixar lotes antigos monopolizarem a fila.
create or replace function public.siso_ml_reconciliacao_claim(
  p_empresa_id uuid, p_run_id uuid, p_lane text, p_limit integer default 60
) returns setof jsonb language plpgsql security invoker set search_path = public
as $$
declare v_pedido public.siso_pedidos%rowtype;
begin
  if p_run_id is null or p_lane not in ('early','dispatch','archive') then
    raise exception 'Parâmetros de conferência inválidos';
  end if;
  -- Bellator é excluída também no banco, inclusive se conectar uma conta no futuro.
  if not exists (
    select 1 from public.siso_empresas e
    where e.id=p_empresa_id and e.ativo and e.ml_reconciliacao_ativa and lower(btrim(e.nome))<>'bellator'
      and (select count(*) from public.siso_ml_connections c
        where c.empresa_id=e.id and c.ativo)=1
  ) then return; end if;

  for v_pedido in
    select p.* from public.siso_pedidos p
    left join public.siso_ml_reconciliacao q on q.pedido_id=p.id
    where p.empresa_origem_id=p_empresa_id
      and p.status<>'cancelado' and not p.separacao_futura and not p.separacao_full
      and p.nome_ecommerce ~* '(mercado|^ML_)'
      and (p.id_pedido_ecommerce ~ '^[0-9]+$' or p.ml_shipment_id ~ '^[0-9]+$')
      and (q.lease_until is null or q.lease_until<now())
      and (q.next_check_at is null or q.next_check_at<=now())
      and (
        (p_lane='early' and p.status_separacao in
          ('aguardando_nf','aguardando_separacao','validacao_oc','em_separacao','separado'))
        or (p_lane='dispatch' and p.status_separacao in ('embalado','conferido')
          and (p.data is null or p.data>=(now() at time zone 'America/Sao_Paulo')::date-30))
        or (p_lane='archive' and p.status_separacao in ('embalado','conferido')
          and p.data<(now() at time zone 'America/Sao_Paulo')::date-30)
      )
    order by q.checked_at asc nulls first,p.data desc nulls last,p.id
    limit greatest(1,least(coalesce(p_limit,60),100))
    for update of p skip locked
  loop
    insert into public.siso_ml_reconciliacao(pedido_id,empresa_id,lease_id,lease_until)
    values(v_pedido.id,p_empresa_id,p_run_id,now()+interval '6 minutes')
    on conflict(pedido_id) do update set
      empresa_id=excluded.empresa_id,lease_id=excluded.lease_id,lease_until=excluded.lease_until
    where siso_ml_reconciliacao.lease_until is null or siso_ml_reconciliacao.lease_until<now();
    if found then return next public.siso_ml_reconciliacao_snapshot(v_pedido); end if;
  end loop;
end; $$;

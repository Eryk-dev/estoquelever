-- Conferência ML passa a tocar SÓ a expedição: embalado/conferido -> expedido
-- quando o ML confirma coleta. Separação, embalagem e etiqueta são físicas e o
-- ML não as enxerga: o substatus "printed" nasce quando o Tiny BAIXA a etiqueta
-- (pré-download do agrupamento), o que jogava pedidos não embalados direto pra
-- embalado; e "2h sem atividade" devolvia wave em andamento pra "Pra separar"
-- sem resetar os itens já marcados. Ambos via UPDATE cru, sem cutover/reset.

create or replace function public.siso_ml_reconciliacao_claim(
  p_empresa_id uuid, p_run_id uuid, p_lane text, p_limit integer default 60
) returns setof jsonb language plpgsql security invoker set search_path = public
as $$
declare v_pedido public.siso_pedidos%rowtype;
begin
  if p_run_id is null or p_lane not in ('dispatch','archive') then
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
      and p.status_separacao in ('embalado','conferido')
      and (
        (p_lane='dispatch'
          and (p.data is null or p.data>=(now() at time zone 'America/Sao_Paulo')::date-30))
        or (p_lane='archive'
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

create or replace function public.siso_ml_reconciliacao_finish(
  p_pedido_id text, p_run_id uuid, p_snapshot jsonb, p_target text,
  p_reason text, p_evidence jsonb, p_error text default null, p_dry_run boolean default false
) returns jsonb language plpgsql security invoker set search_path = public
as $$
declare
  v_p public.siso_pedidos%rowtype;
  v_q public.siso_ml_reconciliacao%rowtype;
  v_snapshot jsonb;
  v_history jsonb;
  v_collected boolean := false;
  v_changed boolean := false;
  v_conflict boolean := false;
  v_result text := p_reason;
begin
  -- Same lock order as claim. Status + audit commit together or neither commits.
  select * into v_p from public.siso_pedidos where id=p_pedido_id for update;
  if not found then return jsonb_build_object('conflict',true); end if;
  select * into v_q from public.siso_ml_reconciliacao where pedido_id=p_pedido_id for update;
  if not found or v_q.lease_id is distinct from p_run_id or v_q.lease_until<now() then
    return jsonb_build_object('conflict',true,'reason','lease_expirado');
  end if;
  v_snapshot := public.siso_ml_reconciliacao_snapshot(v_p);
  v_conflict := v_snapshot is distinct from p_snapshot;
  if not exists(select 1 from public.siso_empresas e where e.id=v_p.empresa_origem_id
    and e.ativo and e.ml_reconciliacao_ativa and lower(btrim(e.nome))<>'bellator')
    or v_p.status='cancelado' or v_p.separacao_futura or v_p.separacao_full
    or v_p.status_separacao not in ('embalado','conferido')
  then v_conflict := true; end if;

  if p_error is null and not v_conflict then
    if p_evidence is null or not exists(
      select 1 from public.siso_ml_connections c where c.id::text=p_evidence->>'connectionId'
        and c.empresa_id=v_p.empresa_origem_id and c.ativo
        and c.ml_user_id::text=p_evidence->>'sellerId'
    ) or p_evidence->>'checkedAt' is null
      or p_evidence->>'kind' is null or p_evidence->>'status' is null
      or p_evidence->>'resourceId' is null or p_evidence->>'resourceId' !~ '^[0-9]+$'
      or p_evidence->>'orderReference' is distinct from v_p.id_pedido_ecommerce
      or (v_p.ml_shipment_id is not null and p_evidence->>'kind'='shipment'
        and p_evidence->>'resourceId' is distinct from v_p.ml_shipment_id)
      or (p_evidence->>'checkedAt')::timestamptz<now()-interval '10 minutes'
      or (p_evidence->>'checkedAt')::timestamptz>now()+interval '1 minute'
      or p_evidence->>'kind' not in ('shipment','order')
    then raise exception 'Evidência ML inválida'; end if;
    v_history := case when jsonb_typeof(p_evidence->'history')='array'
      then p_evidence->'history' else '[]'::jsonb end;
    v_collected := p_evidence->>'kind'='shipment' and (
      p_evidence->>'status' in ('shipped','delivered')
      or (p_evidence->>'status'='ready_to_ship' and p_evidence->>'substatus' in
        ('picked_up','authorized_by_carrier','in_hub','dropped_off'))
      or exists(select 1 from jsonb_array_elements(v_history) h
        where h->>'status' in ('shipped','delivered')
        or (h->>'status'='ready_to_ship' and h->>'substatus' in
          ('picked_up','authorized_by_carrier','in_hub','dropped_off')))
    );

    if p_target is not null and p_target is distinct from v_p.status_separacao then
      if p_target<>'expedido' or not coalesce(v_collected,false)
        or p_evidence->>'status' in ('cancelled','canceled') then
        raise exception 'Transição ML não autorizada: % -> %',v_p.status_separacao,p_target;
      end if;
      if not p_dry_run then
        update public.siso_pedidos set status_separacao='expedido',atualizado_em=now(),updated_at=now()
          where id=p_pedido_id;
        insert into public.siso_pedido_historico(pedido_id,evento,usuario_nome,detalhes)
        values(p_pedido_id,'expedido','Conferência automática Mercado Livre',
          jsonb_build_object('source','ml_reconciliation','run_id',p_run_id,
            'de',v_p.status_separacao,'para','expedido','motivo',p_reason,
            'before',p_snapshot,'ml',p_evidence,'coleta_confirmada',true,'estoque_alterado',false));
        v_changed := true;
      end if;
    end if;
  end if;
  if v_conflict then v_result := 'alterado_durante_consulta'; end if;
  if p_error is not null then v_result := 'erro'; end if;
  update public.siso_ml_reconciliacao set
    lease_id=null,lease_until=null,checked_at=now(),result=v_result,error=left(p_error,500),
    evidence=case when p_error is null then p_evidence else evidence end,
    next_check_at=case
      when p_dry_run or v_conflict then now()
      when p_error is not null then now()+interval '5 minutes'
      when p_evidence->>'kind'='order' and p_evidence->>'noShipping'='true' then now()+interval '1 day'
      when p_evidence->>'status' in ('cancelled','canceled','not_delivered') then now()+interval '1 hour'
      else now()+interval '5 minutes' end
    where pedido_id=p_pedido_id;
  return jsonb_build_object('changed',v_changed,'conflict',v_conflict,'reason',v_result,'dryRun',p_dry_run);
end; $$;

revoke all on function public.siso_ml_reconciliacao_claim(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.siso_ml_reconciliacao_finish(text,uuid,jsonb,text,text,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.siso_ml_reconciliacao_claim(uuid,uuid,text,integer) to service_role;
grant execute on function public.siso_ml_reconciliacao_finish(text,uuid,jsonb,text,text,jsonb,text,boolean) to service_role;

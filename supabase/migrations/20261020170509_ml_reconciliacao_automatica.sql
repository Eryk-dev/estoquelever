-- Conferência ML com leases por pedido, CAS e auditoria atômica.
-- Não movimenta estoque, não inventa bips, impressão ou conferência física.
alter table public.siso_empresas add column ml_reconciliacao_ativa boolean not null default true;
-- Preserva a exclusão mesmo se a empresa mudar de nome posteriormente.
update public.siso_empresas set ml_reconciliacao_ativa=false where lower(btrim(nome))='bellator';

create table public.siso_ml_reconciliacao (
  pedido_id text primary key references public.siso_pedidos(id) on delete cascade,
  empresa_id uuid not null references public.siso_empresas(id),
  lease_id uuid,
  lease_until timestamptz,
  checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  result text,
  error text,
  evidence jsonb
);
alter table public.siso_ml_reconciliacao enable row level security;
revoke all on public.siso_ml_reconciliacao from public, anon, authenticated;
grant select, insert, update, delete on public.siso_ml_reconciliacao to service_role;
create index siso_ml_reconciliacao_due
  on public.siso_ml_reconciliacao(empresa_id, next_check_at);

create function public.siso_ml_reconciliacao_snapshot(p public.siso_pedidos)
returns jsonb language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id, 'empresa_origem_id', p.empresa_origem_id,
    'id_pedido_ecommerce', p.id_pedido_ecommerce, 'ml_shipment_id', p.ml_shipment_id,
    'status', p.status, 'status_separacao', p.status_separacao,
    'etiqueta_status', p.etiqueta_status, 'data', p.data,
    'decisao_final', p.decisao_final,
    'atualizado_em', p.atualizado_em, 'updated_at', p.updated_at,
    'separacao_futura', p.separacao_futura, 'separacao_full', p.separacao_full,
    'ultimo_evento_id', (select h.id from public.siso_pedido_historico h
      where h.pedido_id=p.id order by h.criado_em desc,h.id desc limit 1),
    'impressao_em', (select max(h.criado_em) from public.siso_pedido_historico h
      where h.pedido_id=p.id and h.evento='etiqueta_impressa'),
    'atividade_em', greatest(p.criado_em,p.atualizado_em,p.updated_at,
      p.separacao_iniciada_em,p.separacao_concluida_em,p.embalagem_concluida_em,
      (select max(h.criado_em) from public.siso_pedido_historico h where h.pedido_id=p.id))
  )
$$;

create function public.siso_ml_reconciliacao_claim(
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
    order by coalesce(q.next_check_at,now()),p.data desc nulls last,p.id
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

create function public.siso_ml_reconciliacao_finish(
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
  v_printed boolean := false;
  v_old_no_shipping boolean := false;
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
    or v_p.status_separacao not in
      ('aguardando_nf','aguardando_separacao','validacao_oc','em_separacao','separado','embalado','conferido')
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
    v_printed := coalesce(v_p.etiqueta_status='impresso',false)
      or v_snapshot->>'impressao_em' is not null
      or coalesce(p_evidence->>'substatus'='printed',false)
      or exists(select 1 from jsonb_array_elements(v_history) h where h->>'substatus'='printed');
    v_old_no_shipping := p_evidence->>'kind'='order'
      and p_evidence->>'noShipping'='true' and p_evidence->>'status'='paid'
      and v_p.data<(now() at time zone 'America/Sao_Paulo')::date-20;

    if p_target is not null and p_target is distinct from v_p.status_separacao then
      if p_evidence->>'status' in ('cancelled','canceled') then
        raise exception 'Cancelamento ML não pode avançar etapa';
      end if;
      if p_target='expedido' and coalesce(v_collected,false) then null;
      elsif p_target='embalado'
        and v_p.status_separacao in
          ('aguardando_nf','aguardando_separacao','validacao_oc','em_separacao','separado')
        and (v_printed or coalesce(v_old_no_shipping,false)) then null;
      elsif p_target=(case when v_p.decisao_final='oc' then 'validacao_oc' else 'aguardando_separacao' end)
        and v_p.status_separacao in ('em_separacao','separado')
        and not coalesce(v_collected,false) and not v_printed and not coalesce(v_old_no_shipping,false)
        and (v_snapshot->>'atividade_em')::timestamptz<=now()-interval '2 hours'
        and (p_evidence->>'status' in ('pending','handling','ready_to_ship')
          or (p_evidence->>'kind'='order' and p_evidence->>'status'='paid' and p_evidence->>'noShipping'='true'))
      then null;
      else raise exception 'Transição ML não autorizada: % -> %',v_p.status_separacao,p_target;
      end if;
      if not p_dry_run then
        update public.siso_pedidos set status_separacao=p_target,atualizado_em=now(),updated_at=now()
          where id=p_pedido_id;
        insert into public.siso_pedido_historico(pedido_id,evento,usuario_nome,detalhes)
        values(p_pedido_id,case when p_target='expedido' then 'expedido' else 'status_revertido' end,
          'Conferência automática Mercado Livre',
          jsonb_build_object('source','ml_reconciliation','run_id',p_run_id,
            'de',v_p.status_separacao,'para',p_target,'motivo',p_reason,
            'before',p_snapshot,'ml',p_evidence,'coleta_confirmada',coalesce(v_collected,false),
            'etiqueta_confirmada',v_printed,'estoque_alterado',false));
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

revoke all on function public.siso_ml_reconciliacao_snapshot(public.siso_pedidos) from public,anon,authenticated;
revoke all on function public.siso_ml_reconciliacao_claim(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.siso_ml_reconciliacao_finish(text,uuid,jsonb,text,text,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.siso_ml_reconciliacao_snapshot(public.siso_pedidos) to service_role;
grant execute on function public.siso_ml_reconciliacao_claim(uuid,uuid,text,integer) to service_role;
grant execute on function public.siso_ml_reconciliacao_finish(text,uuid,jsonb,text,text,jsonb,text,boolean) to service_role;

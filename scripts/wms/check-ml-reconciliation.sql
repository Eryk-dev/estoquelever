-- Smoke test transacional, executado após a migração.
-- Usa um pedido elegível como fixture; toda alteração, lease e auditoria é revertida.
begin;
set local role service_role;
do $test$
declare
  v_company uuid;
  v_run uuid := gen_random_uuid();
  v_snapshot jsonb;
  v_before jsonb;
  v_after jsonb;
  v_evidence jsonb;
  v_result jsonb;
  v_count integer;
begin
  if exists(select 1 from public.siso_empresas
    where lower(btrim(nome))='bellator' and ml_reconciliacao_ativa) then
    raise exception 'Bellator não foi excluída';
  end if;
  select id into v_company from public.siso_empresas where lower(nome)='bellator' limit 1;
  select count(*) into v_count from public.siso_ml_reconciliacao_claim(v_company,v_run,'early',1);
  if v_count<>0 then raise exception 'Bellator foi reivindicada'; end if;
  select e.id into v_company from public.siso_empresas e
    where e.ativo and e.ml_reconciliacao_ativa and lower(e.nome)='netair' limit 1;
  select value into v_snapshot
    from public.siso_ml_reconciliacao_claim(v_company,v_run,'early',1) as t(value);
  if v_snapshot is null then raise exception 'Sem fixture elegível'; end if;
  select to_jsonb(p) into v_before from public.siso_pedidos p where id=v_snapshot->>'id';
  select count(*) into v_count from public.siso_ml_reconciliacao_claim(v_company,gen_random_uuid(),'early',100)
    as t(value) where value->>'id'=v_snapshot->>'id';
  if v_count<>0 then raise exception 'Dois workers reivindicaram o mesmo pedido'; end if;

  v_result := public.siso_ml_reconciliacao_finish(v_snapshot->>'id',gen_random_uuid(),
    v_snapshot,null,'teste',null,'erro simulado',false);
  if v_result->>'conflict'<>'true' then raise exception 'Lease estrangeiro aceito'; end if;
  v_result := public.siso_ml_reconciliacao_finish(v_snapshot->>'id',v_run,
    v_snapshot||'{"etiqueta_status":"mudou"}',null,'teste',null,'erro simulado',false);
  if v_result->>'conflict'<>'true' then raise exception 'CAS não protegeu alteração concorrente'; end if;

  update public.siso_ml_reconciliacao set lease_id=v_run,lease_until=now()+interval '6 minutes'
    where pedido_id=v_snapshot->>'id';
  select jsonb_build_object(
    'kind','shipment','resourceId',coalesce(v_snapshot->>'ml_shipment_id','123'),
    'orderReference',v_snapshot->>'id_pedido_ecommerce',
    'connectionId',c.id,'sellerId',c.ml_user_id::text,'checkedAt',now(),
    'status','ready_to_ship','substatus','in_packing_list','noShipping',false,
    'history',jsonb_build_array(jsonb_build_object('date',now(),'status','ready_to_ship','substatus','picked_up'))
  ) into v_evidence from public.siso_ml_connections c where c.empresa_id=v_company and c.ativo limit 1;
  v_result := public.siso_ml_reconciliacao_finish(v_snapshot->>'id',v_run,
    v_snapshot,'expedido','teste_rollback',v_evidence,null,true);
  if v_result->>'changed'<>'false' then raise exception 'Dry-run alterou pedido'; end if;
  select to_jsonb(p) into v_after from public.siso_pedidos p where id=v_snapshot->>'id';
  if v_before is distinct from v_after then raise exception 'Dry-run modificou dados'; end if;
  update public.siso_ml_reconciliacao set lease_id=v_run,lease_until=now()+interval '6 minutes'
    where pedido_id=v_snapshot->>'id';
  v_result := public.siso_ml_reconciliacao_finish(v_snapshot->>'id',v_run,
    v_snapshot,'expedido','teste_rollback',v_evidence,null,false);
  if v_result->>'changed'<>'true' then raise exception 'Coleta no histórico não avançou'; end if;
  select to_jsonb(p) into v_after from public.siso_pedidos p where id=v_snapshot->>'id';
  if (v_before - array['status_separacao','atualizado_em','updated_at'])
    is distinct from (v_after - array['status_separacao','atualizado_em','updated_at']) then
    raise exception 'Conferência alterou estoque ou outro dado operacional';
  end if;
  select count(*) into v_count from public.siso_pedido_historico
    where pedido_id=v_snapshot->>'id' and detalhes->>'run_id'=v_run::text;
  if v_count<>1 then raise exception 'Auditoria não foi gravada exatamente uma vez'; end if;
  v_result := public.siso_ml_reconciliacao_finish(v_snapshot->>'id',v_run,
    v_snapshot,'expedido','teste_rollback',v_evidence,null,false);
  if v_result->>'conflict'<>'true' then raise exception 'Repetição não foi idempotente'; end if;
end; $test$;
rollback;
select 'ok: exclusão, lease, CAS, dry-run, histórico de coleta, auditoria e estoque preservado' as resultado;

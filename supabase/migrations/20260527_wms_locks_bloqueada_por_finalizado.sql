BEGIN;

CREATE OR REPLACE FUNCTION wms_locks_bloqueada_por_finalizado()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT il.id
    FROM siso_inventario_localizacoes il
    JOIN siso_inventario_operadores op
      ON op.sessao_id = il.sessao_id
     AND op.usuario_id = il.bloqueada_por
   WHERE il.status = 'em_contagem'
     AND il.bloqueada_por IS NOT NULL
     AND op.finalizado_em IS NOT NULL;
$function$;

COMMIT;

-- DOWN: DROP FUNCTION wms_locks_bloqueada_por_finalizado();

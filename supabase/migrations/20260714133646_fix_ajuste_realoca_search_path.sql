-- wms_inserir_movimentacao ainda referencia tabelas sem schema qualificado e
-- herda o search_path do caller. Mantemos um path explicito e imutavel, sem
-- depender da configuracao da sessao PostgREST.

ALTER FUNCTION public.wms_ajustar_estoque_realocando_reservas(
  uuid, uuid, uuid, numeric, text, text, text, uuid, numeric, uuid[]
) SET search_path = public, pg_temp;

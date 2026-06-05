-- Harness de testes: incluir siso_transferencias_galpao no TRUNCATE.
-- A tabela ativa de transferência inter-galpão nunca era truncada (vazava
-- entre runs da suíte). CASCADE cobre as tabelas-filhas via FK.
CREATE OR REPLACE FUNCTION public.wms_truncate_operacional()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  TRUNCATE
    siso_movimentacoes,
    siso_estoque,
    siso_custo_medio,
    siso_pedidos,
    siso_fila_execucao,
    siso_wms_pendencias_guarda,
    siso_inventario_sessoes,
    siso_transferencias_galpao,
    siso_ordens_compra,
    siso_devolucoes_pendentes,
    siso_webhook_logs,
    siso_api_calls,
    siso_logs,
    siso_erros,
    siso_localizacao_locks
  CASCADE;
END;
$function$;

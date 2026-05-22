-- Test harness RPC — limpa tabelas operacionais preservando catálogo.
-- Usado pela suite de scenarios em scripts/wms/cenarios/run-all.ts.
-- Spec: docs/superpowers/specs/2026-05-21-sistematica-testes-estoque-design.md

CREATE OR REPLACE FUNCTION wms_truncate_operacional() RETURNS void AS $$
BEGIN
  TRUNCATE
    siso_movimentacoes,
    siso_estoque,
    siso_custo_medio,
    siso_pedidos,
    siso_fila_execucao,
    siso_wms_pendencias_guarda,
    siso_inventario_sessoes,
    siso_transferencias,
    siso_ordens_compra,
    siso_devolucoes_pendentes,
    siso_webhook_logs,
    siso_api_calls,
    siso_logs,
    siso_erros,
    siso_localizacao_locks
  CASCADE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION wms_truncate_operacional() IS
  'Test harness: limpa só operacional. Preserva empresas/galpões/locs/usuários/fornecedores/produtos.';

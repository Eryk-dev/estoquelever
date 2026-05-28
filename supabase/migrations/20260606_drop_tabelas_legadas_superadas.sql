-- Fase 0 (limpeza de legado) — dropa tabelas 0-linha superadas por modelos novos.
--
--   siso_transferencias / siso_transferencia_itens → modelo de transferência
--     antigo; o ativo é siso_transferencias_galpao.
--   siso_inventarios / siso_inventario_itens       → inventário v1; o ativo é
--     siso_inventario_sessoes / siso_inventario_localizacoes / _contagens / _divergencias.
--   siso_operadores                                → superado por siso_usuarios.
--
-- Confirmado antes do drop (staging ehbxpbeijofxtsbezwxd):
--   - 0 linhas em todas;
--   - 0 leituras no código (grep em src);
--   - únicas FKs são internas (filho→pai), nenhuma tabela externa referencia;
--   - 0 views/matviews dependentes.
-- Drop em ordem: filhos antes dos pais.

DROP TABLE IF EXISTS siso_transferencia_itens;
DROP TABLE IF EXISTS siso_transferencias;
DROP TABLE IF EXISTS siso_inventario_itens;
DROP TABLE IF EXISTS siso_inventarios;
DROP TABLE IF EXISTS siso_operadores;

-- O harness de testes (wms_truncate_operacional) referenciava siso_transferencias
-- (tabela legada agora dropada). Remove da lista de TRUNCATE — a tabela ativa é
-- siso_transferencias_galpao, que o harness nunca truncava (comportamento mantido).
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

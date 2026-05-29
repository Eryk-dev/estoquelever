import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * Após uma entrada de saldo (mov E em loc do galpão), varre pedidos cujos
 * items são desse produto e:
 *   1. Marca pedidos em status_separacao='validacao_oc' com flag_saldo_apareceu=true
 *      → frontend mostra banner "Saldo apareceu — confere antes de Esgotado".
 *   2. Atualiza disponivel no snapshot dos pedidos em separação aberta
 *      (aguardando_separacao | em_separacao) — sem isso o saldo recente
 *      não aparece pro operador no checklist.
 *
 * Decisão 5 (28/05): chamada fire-and-forget após qualquer mov tipo='E'
 * (recebimento OC, transferência, avulso, ajuste manual).
 */
export async function varrerPedidosAfetadosPorEntrada(args: {
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
}): Promise<{ flagsMarcadas: number; locsAtualizadas: number }> {
  const supabase = createServiceClient();

  // Resolve tiny_produto_id (mapping reverso: WMS uuid → bigint) e empresa
  const { data: mapeamento } = await supabase
    .from("siso_produto_empresas")
    .select("tiny_produto_id, empresa_id")
    .eq("produto_id", args.produto_id);
  const tinyByEmpresa = new Map<string, Set<number>>();
  for (const m of mapeamento ?? []) {
    const eid = String(m.empresa_id);
    if (!tinyByEmpresa.has(eid)) tinyByEmpresa.set(eid, new Set());
    tinyByEmpresa.get(eid)!.add(Number(m.tiny_produto_id));
  }
  if (tinyByEmpresa.size === 0) {
    return { flagsMarcadas: 0, locsAtualizadas: 0 };
  }

  // Recomputa disp agregada por galpão pra esse produto (vai propagar pra snapshots)
  const { data: estoquePorGalpao } = await supabase
    .from("siso_estoque")
    .select("disponivel")
    .eq("produto_id", args.produto_id)
    .eq("galpao_id", args.galpao_id);
  const dispTotalGalpao = (estoquePorGalpao ?? []).reduce(
    (sum, row) => sum + Number(row.disponivel ?? 0),
    0,
  );

  // Resolve codigo da loc pra usar no snapshot.localizacao
  const { data: locInfo } = await supabase
    .from("siso_localizacoes")
    .select("codigo")
    .eq("id", args.localizacao_id)
    .maybeSingle();

  let flagsMarcadas = 0;
  let locsAtualizadas = 0;

  // Itera por empresa pra encontrar pedidos afetados via tiny_produto_id
  for (const [empresaId, tinyIds] of tinyByEmpresa) {
    const tinyArr = Array.from(tinyIds);

    // 1. Pedidos em validacao_oc com items desse produto+empresa+galpão
    const { data: itensValidacao } = await supabase
      .from("siso_pedido_itens")
      .select(
        "pedido_id, siso_pedidos!inner(status_separacao, separacao_galpao_id, empresa_origem_id)",
      )
      .in("produto_id", tinyArr)
      .eq("siso_pedidos.status_separacao", "validacao_oc")
      .eq("siso_pedidos.separacao_galpao_id", args.galpao_id)
      .eq("siso_pedidos.empresa_origem_id", empresaId);

    const pedidoIdsValidacao = new Set<string>(
      (itensValidacao ?? []).map((i) => String(i.pedido_id)),
    );
    if (pedidoIdsValidacao.size > 0) {
      const { error } = await supabase
        .from("siso_pedidos")
        .update({ flag_saldo_apareceu: true })
        .in("id", Array.from(pedidoIdsValidacao));
      if (!error) flagsMarcadas += pedidoIdsValidacao.size;
    }

    // 2. (Fase 1.4 — 2026-05-28) REMOVIDO: sync do snapshot
    //    siso_pedido_item_estoques (disp + localizacao). A tabela foi dropada —
    //    pedidos em separação leem saldo/loc vivos de siso_estoque. A flag
    //    flag_saldo_apareceu (acima) segue marcando os pedidos em validacao_oc.
  }

  if (flagsMarcadas > 0 || locsAtualizadas > 0) {
    logger.info("varredura-validacao-oc", "varredura pós-entrada", {
      produto_id: args.produto_id,
      galpao_id: args.galpao_id,
      flagsMarcadas,
      locsAtualizadas,
      dispTotalGalpao,
    });
  }

  return { flagsMarcadas, locsAtualizadas };
}

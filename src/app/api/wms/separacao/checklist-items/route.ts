import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/separacao/checklist-items?pedidos=id1,id2,id3
 *
 * Fetch individual items for the given pedido IDs with localizacao
 * from the separating empresa's stock data. For transfers, this is
 * the empresa in the separacao_galpao (the one that will ship), not
 * the empresa that originally received the order.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const pedidosParam = searchParams.get("pedidos");

  if (!pedidosParam) {
    return NextResponse.json(
      { error: "'pedidos' query param é obrigatório" },
      { status: 400 },
    );
  }

  const pedido_ids = pedidosParam.split(",").filter(Boolean);
  if (pedido_ids.length === 0) {
    return NextResponse.json(
      { error: "Nenhum pedido_id válido" },
      { status: 400 },
    );
  }

  const modo = searchParams.get("modo");
  const isPickOC = modo === "pick-oc" || modo === "embalagem-oc";

  const supabase = createServiceClient();

  try {
    // 1. Fetch items for the given pedidos.
    // Compra filtering is applied later based on the pedido status.
    const { data: items, error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, gtin, descricao, quantidade_pedida, separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo, imagem_url, compra_status, quantidade_pega, separacao_parcial, parcial_motivo, parcial_em",
      )
      .in("pedido_id", pedido_ids);

    if (itemsError) {
      logger.error("checklist-items", "Failed to fetch items", {
        error: itemsError.message,
      });
      return NextResponse.json(
        { error: itemsError.message },
        { status: 500 },
      );
    }

    // 2. Fetch empresa_origem_id + separacao_galpao_id per pedido
    const { data: pedidos } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, separacao_galpao_id, status_separacao")
      .in("id", pedido_ids);

    const pedidoStatusMap = new Map<string, string | null>();
    for (const pedido of pedidos ?? []) {
      pedidoStatusMap.set(pedido.id, pedido.status_separacao ?? null);
    }

    // 2b. Resolve the "separating empresa" — the empresa in the galpão
    //     that will physically separate/ship the order.
    //     For propria: same galpão as origem. For transferencia: the other galpão.
    const uniqueGalpaoIds = [
      ...new Set(
        (pedidos ?? []).map((p) => p.separacao_galpao_id).filter(Boolean),
      ),
    ];

    // Map galpao_id -> first active empresa_id
    const galpaoToEmpresaMap = new Map<string, string>();
    if (uniqueGalpaoIds.length > 0) {
      const { data: empresasInGalpoes } = await supabase
        .from("siso_empresas")
        .select("id, galpao_id")
        .in("galpao_id", uniqueGalpaoIds)
        .eq("ativo", true);
      for (const emp of empresasInGalpoes ?? []) {
        if (!galpaoToEmpresaMap.has(emp.galpao_id)) {
          galpaoToEmpresaMap.set(emp.galpao_id, emp.id);
        }
      }
    }

    // pedido -> empresa that will separate (used for stock + localizacao)
    const pedidoSepEmpresaMap = new Map<string, string>();
    for (const p of pedidos ?? []) {
      if (p.separacao_galpao_id) {
        const empresaId = galpaoToEmpresaMap.get(p.separacao_galpao_id);
        if (empresaId) {
          pedidoSepEmpresaMap.set(p.id, empresaId);
          continue;
        }
      }
      // Fallback: use empresa_origem if separacao_galpao_id is missing
      if (p.empresa_origem_id) {
        pedidoSepEmpresaMap.set(p.id, p.empresa_origem_id);
      }
    }

    // 3. Fetch localizacao + stock from siso_pedido_item_estoques
    const { data: estoques } = await supabase
      .from("siso_pedido_item_estoques")
      .select("pedido_id, produto_id, empresa_id, localizacao, saldo, disponivel")
      .in("pedido_id", pedido_ids);

    // Build localizacao + stock maps (separating empresa only)
    const locMap = new Map<string, string>();
    const stockMap = new Map<string, { saldo: number; disponivel: number }>();
    for (const e of estoques ?? []) {
      const sepEmpresa = pedidoSepEmpresaMap.get(e.pedido_id);
      if (e.empresa_id === sepEmpresa) {
        const key = `${e.pedido_id}:${e.produto_id}`;
        if (e.localizacao) locMap.set(key, e.localizacao);
        stockMap.set(key, {
          saldo: e.saldo ?? 0,
          disponivel: e.disponivel ?? 0,
        });
      }
    }

    // 3b. Fetch galpao name for separating empresas (needed for stock adjustment calls)
    const uniqueEmpresaIds = Array.from(new Set(pedidoSepEmpresaMap.values()));
    const galpaoMap = new Map<string, string>();
    if (uniqueEmpresaIds.length > 0) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id, siso_galpoes(nome)")
        .in("id", uniqueEmpresaIds);
      for (const emp of empresas ?? []) {
        const g = emp.siso_galpoes as unknown as { nome: string } | null;
        if (g?.nome) galpaoMap.set(emp.id, g.nome);
      }
    }

    // 3c. Fetch realocacoes (todos os status) para todos os itens.
    // 3D: pool fungível por (produto, galpao) — não expomos empresa_dona/devedora/is_emprestimo.
    const itemIds = (items ?? []).map((i) => i.id);
    let realocacoes: Array<{
      id: string;
      pedido_item_id: number;
      parent_realocacao_id: string | null;
      galpao_id: string | null;
      localizacao_id: string | null;
      quantidade: number;
      quantidade_pega: number | null;
      parcial: boolean;
      parcial_motivo: string | null;
      status: string;
      criado_em: string;
    }> = [];

    if (itemIds.length > 0) {
      const { data: realocacoesRaw } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select(
          "id, pedido_item_id, parent_realocacao_id, galpao_id, localizacao_id, quantidade, quantidade_pega, parcial, parcial_motivo, status, criado_em",
        )
        .in("pedido_item_id", itemIds);
      realocacoes = realocacoesRaw ?? [];
    }

    // Fetch localizacao codes for realocacoes
    const localizacaoIds = [
      ...new Set(realocacoes.map((r) => r.localizacao_id).filter(Boolean) as string[]),
    ];
    const localizacaoCodigoMap = new Map<string, string>();
    if (localizacaoIds.length > 0) {
      const { data: locs } = await supabase
        .from("siso_localizacoes")
        .select("id, codigo")
        .in("id", localizacaoIds);
      for (const loc of locs ?? []) {
        localizacaoCodigoMap.set(loc.id, loc.codigo);
      }
    }

    // Build map pedido_item_id -> realocacoes[]
    const realocacoesPorItem = new Map<string, typeof realocacoes>();
    for (const r of realocacoes) {
      const arr = realocacoesPorItem.get(String(r.pedido_item_id)) ?? [];
      arr.push(r);
      realocacoesPorItem.set(String(r.pedido_item_id), arr);
    }

    // 4. Shape response (empresa_origem_id = separating empresa for location updates)
    // In pick-oc mode, show ALL items (including OC items) so the operator can pick them.
    // In normal mode, hide OC items for aguardando_compra pedidos.
    const visibleItems = (items ?? []).filter((item) => {
      if (item.compra_status === "indisponivel" || item.compra_status === "cancelado") {
        return false;
      }

      if (!isPickOC) {
        const pedidoStatus = pedidoStatusMap.get(item.pedido_id);
        if (pedidoStatus === "aguardando_compra") {
          return item.compra_status == null;
        }
      }

      return true;
    });

    const result = visibleItems.map((item) => {
      const sepEmpresaId = pedidoSepEmpresaMap.get(item.pedido_id) ?? null;
      const itemRealocacoes = (realocacoesPorItem.get(String(item.id)) ?? []).map((r) => ({
        id: r.id,
        parent_realocacao_id: r.parent_realocacao_id,
        localizacao_id: r.localizacao_id,
        localizacao_codigo: r.localizacao_id
          ? (localizacaoCodigoMap.get(r.localizacao_id) ?? null)
          : null,
        quantidade: r.quantidade,
        quantidade_pega: r.quantidade_pega,
        parcial: r.parcial,
        parcial_motivo: r.parcial_motivo,
        status: r.status,
        criado_em: r.criado_em,
      }));
      return {
        id: item.id,
        pedido_id: item.pedido_id,
        produto_id: item.produto_id,
        sku: item.sku,
        gtin: item.gtin,
        descricao: item.descricao,
        quantidade: item.quantidade_pedida,
        separacao_marcado: item.separacao_marcado ?? false,
        separacao_marcado_em: item.separacao_marcado_em,
        quantidade_bipada: item.quantidade_bipada ?? 0,
        bipado_completo: item.bipado_completo ?? false,
        imagem_url: item.imagem_url ?? null,
        compra_status: item.compra_status ?? null,
        localizacao:
          locMap.get(`${item.pedido_id}:${item.produto_id}`) ?? null,
        saldo: stockMap.get(`${item.pedido_id}:${item.produto_id}`)?.saldo ?? 0,
        disponivel: stockMap.get(`${item.pedido_id}:${item.produto_id}`)?.disponivel ?? 0,
        empresa_origem_id: sepEmpresaId,
        galpao_nome: galpaoMap.get(sepEmpresaId ?? "") ?? null,
        quantidade_pega: item.quantidade_pega ?? null,
        separacao_parcial: item.separacao_parcial ?? false,
        parcial_motivo: item.parcial_motivo ?? null,
        parcial_em: item.parcial_em ?? null,
        realocacoes: itemRealocacoes,
      };
    });

    return NextResponse.json({ items: result });
  } catch (err) {
    logger.error("checklist-items", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

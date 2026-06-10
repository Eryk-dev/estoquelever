import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

/**
 * POST /api/compras/comprar
 *
 * Marks items as purchased (comprado) for a supplier.
 * Qty is consolidated by SKU — distributed across order items by aging (oldest first).
 *
 * Body: {
 *   itens: Array<{ sku: string, quantidade_comprada: number }>
 * }
 *
 * Only comprador or admin can call this.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  if (!userCan(session, "compras.executar")) {
    return NextResponse.json(
      { error: "Apenas compradores podem marcar como comprado" },
      { status: 403 },
    );
  }

  const body = await request.json();
  const itens = body.itens as
    | Array<{ sku: string; quantidade_comprada: number }>
    | undefined;
  const fornecedorOc =
    typeof body.fornecedor_oc === "string" && body.fornecedor_oc.trim().length > 0
      ? body.fornecedor_oc.trim()
      : null;

  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    return NextResponse.json(
      { error: "Envie { itens: [{ sku, quantidade_comprada }] }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const resultados: Array<{
    sku: string;
    itens_marcados: number;
    quantidade_alocada: number;
    quantidade_excedente: number;
  }> = [];
  let firstOcId: string | null = null;
  // OCs vinculadas nesta rodada — flipam pra 'comprado' no final (sem isso o
  // doc fica preso em 'aguardando_compra' e a aba Receber nunca o lista).
  const ocIdsTocadas = new Set<string>();

  // Per-pedido audit aggregator (1 evento compra_item_comprado por pedido).
  const eventosPorPedido = new Map<
    string,
    { qty: number; skus: string[] }
  >();

  try {
    for (const { sku, quantidade_comprada } of itens) {
      if (!sku || quantidade_comprada <= 0) continue;

      // Fetch all order items for this SKU that are aguardando_compra.
      // Include fornecedor_oc + pedido.empresa_origem_id + pedido.separacao_galpao_id
      // pra resolver find-or-create da OC.
      const { data: orderItems, error: fetchErr } = await supabase
        .from("siso_pedido_itens")
        .select(
          "id, pedido_id, quantidade_pedida, compra_quantidade_solicitada, fornecedor_oc, siso_pedidos(criado_em, empresa_origem_id, separacao_galpao_id)",
        )
        .eq("sku", sku)
        .eq("compra_status", "aguardando_compra")
        .order("id"); // stable order; we'll sort by aging below

      if (fetchErr) {
        logger.error("compras-comprar", `Erro ao buscar itens do SKU ${sku}`, {
          error: fetchErr.message,
        });
        continue;
      }

      if (!orderItems || orderItems.length === 0) continue;

      // Sort by order creation date (oldest first = highest priority)
      const sorted = [...orderItems].sort((a, b) => {
        const dateA =
          (a.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        const dateB =
          (b.siso_pedidos as { criado_em?: string } | null)?.criado_em ?? "";
        return dateA.localeCompare(dateB);
      });

      // Distribute quantidade_comprada across items by aging
      let remaining = quantidade_comprada;
      let marcados = 0;
      let alocado = 0;

      for (const item of sorted) {
        if (remaining <= 0) break;

        const qtySolicitada =
          Number(item.compra_quantidade_solicitada ?? 0) ||
          Number(item.quantidade_pedida ?? 0);
        const qtyParaEsteItem = Math.min(remaining, qtySolicitada);

        // Resolve fornecedor + galpao_id pra find-or-create da OC.
        // Prioridade: fornecedor_oc (set pelo operador via validar-oc-item) →
        // fallback no mapeamento canônico por prefixo de SKU.
        const fornecedor =
          ((item as { fornecedor_oc?: string | null }).fornecedor_oc as
            | string
            | null) ?? getFornecedorBySku(sku).fornecedor;
        const pedidoData = item.siso_pedidos as {
          empresa_origem_id?: string;
          separacao_galpao_id?: string | null;
        } | null;
        const empresaOrigemId = pedidoData?.empresa_origem_id ?? null;
        let galpaoId = pedidoData?.separacao_galpao_id ?? null;
        if (!galpaoId && empresaOrigemId) {
          const { data: pref } = await supabase
            .from("siso_empresa_galpoes_preferenciais")
            .select("galpao_id")
            .eq("empresa_id", empresaOrigemId)
            .limit(1)
            .maybeSingle();
          galpaoId = (pref?.galpao_id as string | null) ?? null;
        }

        const ocId = await findOrCreateOC(supabase, {
          fornecedor,
          galpaoId,
          empresaId: empresaOrigemId,
          sku,
        });
        if (!firstOcId && ocId) firstOcId = ocId;
        if (ocId) ocIdsTocadas.add(ocId);

        const updatePayload: Record<string, unknown> = {
          compra_status: "comprado",
          compra_quantidade_comprada: qtyParaEsteItem,
          comprado_em: now,
          comprado_por: session.id,
          comprado_por_nome: session.nome,
        };
        if (ocId) updatePayload.ordem_compra_id = ocId;
        // P6 #6.29/#3.11 — persiste fornecedor escolhido no body pra audit.
        if (fornecedorOc) updatePayload.fornecedor_oc = fornecedorOc;

        const { error: updateErr } = await supabase
          .from("siso_pedido_itens")
          .update(updatePayload)
          .eq("id", item.id);

        if (updateErr) {
          logger.error(
            "compras-comprar",
            `Erro ao marcar item ${item.id} como comprado`,
            { error: updateErr.message },
          );
          continue;
        }

        remaining -= qtyParaEsteItem;
        marcados++;
        alocado += qtyParaEsteItem;

        const pedidoId = item.pedido_id as string;
        const cur = eventosPorPedido.get(pedidoId) ?? { qty: 0, skus: [] };
        cur.qty += qtyParaEsteItem;
        if (!cur.skus.includes(sku)) cur.skus.push(sku);
        eventosPorPedido.set(pedidoId, cur);
      }

      resultados.push({
        sku,
        itens_marcados: marcados,
        quantidade_alocada: alocado,
        quantidade_excedente: Math.max(remaining, 0),
      });
    }

    // Confirma as OCs desta rodada: 'aguardando_compra' → 'comprado' (mesma
    // semântica de POST /compras/ordens). É isso que faz o documento aparecer
    // na aba Receber (fetchReceber filtra status='comprado').
    if (ocIdsTocadas.size > 0) {
      const { error: flipErr } = await supabase
        .from("siso_ordens_compra")
        .update({
          status: "comprado",
          comprado_por: session.id,
          comprado_em: now,
        })
        .in("id", [...ocIdsTocadas])
        .eq("status", "aguardando_compra");
      if (flipErr) {
        logger.error("compras-comprar", "Erro ao confirmar OCs como compradas", {
          error: flipErr.message,
          oc_ids: [...ocIdsTocadas],
        });
      }
    }

    // Audit trail: 1 evento compra_item_comprado por pedido afetado.
    if (eventosPorPedido.size > 0) {
      await registrarEventos(
        Array.from(eventosPorPedido.entries()).map(([pedidoId, info]) => ({
          pedidoId,
          evento: "compra_item_comprado" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: {
            qty_total: info.qty,
            skus: info.skus,
          },
        })),
      );
    }

    logger.info("compras-comprar", "Itens marcados como comprado", {
      usuario: session.nome,
      total_skus: resultados.length,
      total_itens: resultados.reduce((s, r) => s + r.itens_marcados, 0),
      ordem_id: firstOcId,
    });

    return NextResponse.json({ ok: true, resultados, ordem_id: firstOcId });
  } catch (err) {
    logger.error("compras-comprar", "Erro ao processar compra", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro interno ao processar compra" },
      { status: 500 },
    );
  }
}

// ─── Helper: find or create OC (defense-in-depth para finding #3.2) ──────
// Mesmo que `validar-oc-item` já faça find-or-create, /compras/comprar
// precisa garantir vínculo — senão compras-release nunca acha a OC e o
// pedido fica preso.
async function findOrCreateOC(
  supabase: ReturnType<typeof createServiceClient>,
  args: { fornecedor: string; galpaoId: string | null; empresaId: string | null; sku: string },
): Promise<string | null> {
  const { fornecedor, galpaoId, empresaId, sku } = args;
  if (!fornecedor) return null;

  let query = supabase
    .from("siso_ordens_compra")
    .select("id")
    .eq("fornecedor", fornecedor)
    .eq("status", "aguardando_compra")
    .limit(1);
  if (galpaoId) query = query.eq("galpao_id", galpaoId);
  else if (empresaId) query = query.eq("empresa_id", empresaId);

  const { data: existing } = await query.maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from("siso_ordens_compra")
    .insert({
      fornecedor,
      galpao_id: galpaoId,
      empresa_id: empresaId,
      status: "aguardando_compra",
      observacao: `Criada por /compras/comprar — SKU ${sku}`,
    })
    .select("id")
    .single();
  if (error) {
    logger.warn("compras-comprar", "Erro criando OC", {
      error: error.message,
      fornecedor,
    });
    return null;
  }
  return created.id as string;
}

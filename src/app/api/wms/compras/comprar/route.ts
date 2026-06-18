import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEventos } from "@/lib/historico-service";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { findOrCreateOcAberta } from "@/lib/compras-oc";

/**
 * POST /api/compras/comprar
 *
 * Marks items as purchased (comprado) for a supplier.
 * Qty is consolidated by SKU — distributed across order items by aging (oldest first).
 *
 * Body: {
 *   itens: Array<{ sku: string, quantidade_comprada: number, galpao_id?: string, preco_unitario?: number }>
 * }
 *
 * `galpao_id` (escolhido pelo comprador) define o galpão de recebimento da OC —
 * itens do mesmo fornecedor+galpão consolidam numa OC só. Sem ele, fallback no
 * galpão do pedido (comportamento legado, usado pelos cenários E2E).
 * `preco_unitario` é gravado em compra_preco_unitario e sugere o custo no recebimento.
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
    | Array<{
        sku: string;
        quantidade_comprada: number;
        galpao_id?: string | null;
        preco_unitario?: number | null;
      }>
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

  for (const it of itens) {
    if (it.preco_unitario != null && !(Number(it.preco_unitario) > 0)) {
      return NextResponse.json(
        { error: `Preço unitário inválido pro SKU ${it.sku}` },
        { status: 400 },
      );
    }
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
    {
      qty: number;
      skus: string[];
      ajustes_solicitada: Array<{
        item_id: string;
        sku: string;
        solicitada_anterior: number;
        solicitada_nova: number;
      }>;
    }
  >();
  // Pedidos cujo separacao_galpao_id precisa seguir o galpão escolhido pelo
  // comprador — senão a entrada chega num galpão e o reconciliador-oc procura
  // o pedido no outro (match por siso_pedidos.separacao_galpao_id) e nunca destrava.
  const pedidosGalpao = new Map<string, string>();
  // P2-CMP-08: primeiro galpão escolhido por pedido na rodada (determinístico).
  // Pedido multi-SKU com galpões escolhidos diferentes → mantém o primeiro + warn.
  const galpaoEscolhidoPorPedido = new Map<string, string>();
  // P3-11: cache empresa_id → galpão preferencial, populado sob demanda mas no
  // máximo 1 query por empresa (mata o N+1 do SELECT por item). undefined = não
  // resolvido ainda; null = resolvido e sem preferencial.
  const galpaoPreferencialPorEmpresa = new Map<string, string | null>();
  async function resolverGalpaoPreferencial(
    empresaId: string,
  ): Promise<string | null> {
    if (galpaoPreferencialPorEmpresa.has(empresaId)) {
      return galpaoPreferencialPorEmpresa.get(empresaId) ?? null;
    }
    const { data: pref } = await supabase
      .from("siso_empresa_galpoes_preferenciais")
      .select("galpao_id")
      .eq("empresa_id", empresaId)
      .limit(1)
      .maybeSingle();
    const gid = (pref?.galpao_id as string | null) ?? null;
    galpaoPreferencialPorEmpresa.set(empresaId, gid);
    return gid;
  }

  try {
    for (const { sku, quantidade_comprada, galpao_id, preco_unitario } of itens) {
      if (!sku || quantidade_comprada <= 0) continue;
      const galpaoEscolhido =
        typeof galpao_id === "string" && galpao_id.length > 0 ? galpao_id : null;

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
        // Galpão escolhido pelo comprador manda; fallback legado no galpão do
        // pedido (cenários E2E ainda mandam payload sem galpao_id).
        let galpaoId = galpaoEscolhido ?? pedidoData?.separacao_galpao_id ?? null;
        if (!galpaoId && empresaOrigemId) {
          galpaoId = await resolverGalpaoPreferencial(empresaOrigemId);
        }

        const ocId = await findOrCreateOcAberta(supabase, {
          fornecedor,
          galpaoId,
          empresaId: empresaOrigemId,
          observacao: `Criada por /compras/comprar — SKU ${sku}`,
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
        // CMP-01: compra parcial (comprada < solicitada) — ajusta a solicitada
        // pra baixo (= comprada) no mesmo UPDATE. O flip pra 'recebido'
        // (receber-oc.ts / compras/receber) e o release usam SOLICITADA; sem o
        // ajuste o item comprado parcial nunca fecha. O restante da demanda
        // volta a ser visto pela necessidade viva (emTransito cai junto).
        const compraParcial = qtyParaEsteItem < qtySolicitada;
        if (compraParcial) {
          updatePayload.compra_quantidade_solicitada = qtyParaEsteItem;
        }
        if (ocId) updatePayload.ordem_compra_id = ocId;
        // P6 #6.29/#3.11 — persiste fornecedor escolhido no body pra audit.
        if (fornecedorOc) updatePayload.fornecedor_oc = fornecedorOc;
        if (preco_unitario != null)
          updatePayload.compra_preco_unitario = Number(preco_unitario);

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
        if (galpaoEscolhido) {
          const escolhaAnterior = galpaoEscolhidoPorPedido.get(pedidoId);
          if (escolhaAnterior && escolhaAnterior !== galpaoEscolhido) {
            // P2-CMP-08: mesmo pedido com SKUs comprados pra galpões DIFERENTES
            // na mesma rodada — mantém o PRIMEIRO (determinístico). A entrada
            // do outro SKU não vai casar no reconciliador (match por
            // siso_pedidos.separacao_galpao_id).
            logger.warn(
              "compras-comprar",
              "Pedido multi-SKU com galpões escolhidos diferentes na mesma rodada — mantendo o primeiro",
              {
                pedido_id: pedidoId,
                galpao_mantido: escolhaAnterior,
                galpao_ignorado: galpaoEscolhido,
                sku,
              },
            );
          } else if (!escolhaAnterior) {
            galpaoEscolhidoPorPedido.set(pedidoId, galpaoEscolhido);
            if (pedidoData?.separacao_galpao_id !== galpaoEscolhido) {
              pedidosGalpao.set(pedidoId, galpaoEscolhido);
            }
          }
        }
        const cur = eventosPorPedido.get(pedidoId) ?? {
          qty: 0,
          skus: [],
          ajustes_solicitada: [],
        };
        cur.qty += qtyParaEsteItem;
        if (!cur.skus.includes(sku)) cur.skus.push(sku);
        if (compraParcial) {
          cur.ajustes_solicitada.push({
            item_id: String(item.id),
            sku,
            solicitada_anterior: qtySolicitada,
            solicitada_nova: qtyParaEsteItem,
          });
        }
        eventosPorPedido.set(pedidoId, cur);
      }

      resultados.push({
        sku,
        itens_marcados: marcados,
        quantidade_alocada: alocado,
        quantidade_excedente: Math.max(remaining, 0),
      });
    }

    // Re-aponta separacao_galpao_id dos pedidos pro galpão escolhido pelo
    // comprador (batch por galpão). Sem isso o reconciliador-oc nunca casa a
    // entrada com o pedido.
    // CMP-02: guarda de status — só repontar pedido parado no fluxo de compra.
    // Espelha compras-release (aguardando_compra/comprado) + validacao_oc
    // (estado pré-separação do fluxo OC; reconciliador-oc transiciona
    // validacao_oc/aguardando_compra). Pedido misto em separação ativa NÃO é
    // repontado — senão some da wave do galpão atual com item já na bancada.
    if (pedidosGalpao.size > 0) {
      const statusPermitidos = ["aguardando_compra", "validacao_oc", "comprado"];
      const porGalpao = new Map<string, string[]>();
      for (const [pedidoId, gId] of pedidosGalpao) {
        const lista = porGalpao.get(gId) ?? [];
        lista.push(pedidoId);
        porGalpao.set(gId, lista);
      }
      for (const [gId, pedidoIds] of porGalpao) {
        const { data: repontados, error: galpErr } = await supabase
          .from("siso_pedidos")
          .update({ separacao_galpao_id: gId })
          .in("id", pedidoIds)
          .in("status_separacao", statusPermitidos)
          .select("id");
        if (galpErr) {
          logger.error(
            "compras-comprar",
            "Erro ao re-apontar galpão de separação dos pedidos",
            { error: galpErr.message, galpao_id: gId, pedido_ids: pedidoIds },
          );
          continue;
        }
        const repontadosSet = new Set(
          (repontados ?? []).map((p) => p.id as string),
        );
        const pulados = pedidoIds.filter((id) => !repontadosSet.has(id));
        if (pulados.length > 0) {
          logger.warn(
            "compras-comprar",
            "Pedidos fora do fluxo de compra — separacao_galpao_id NÃO repontado",
            { galpao_id: gId, pedido_ids: pulados },
          );
        }
      }
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
            // CMP-01: audit do ajuste de solicitada em compra parcial.
            ...(info.ajustes_solicitada.length > 0
              ? { ajustes_solicitada: info.ajustes_solicitada }
              : {}),
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

// Criação de OC unificada em `findOrCreateOcAberta` (@/lib/compras-oc) — race-safe,
// compartilhada com /api/wms/separacao/validar-oc-item.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";

import type { ProdutoConsolidado } from "@/types";

/**
 * POST /api/separacao/iniciar
 *
 * Start separation for selected orders: moves them to em_separacao
 * and returns a consolidated product checklist for wave picking.
 *
 * Headers: X-Session-Id
 * Body: { pedido_ids: string[], operador_id: string }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string") ||
    !body.operador_id ||
    typeof body.operador_id !== "string"
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) e 'operador_id' (string) são obrigatórios" },
      { status: 400 },
    );
  }

  const { pedido_ids, operador_id } = body as {
    pedido_ids: string[];
    operador_id: string;
  };

  const supabase = createServiceClient();

  try {
    // 1. Fetch all referenced pedidos and validate status
    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao")
      .in("id", pedido_ids);

    if (fetchError) {
      logger.error("separacao-iniciar", "Failed to fetch pedidos", {
        error: fetchError.message,
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    // Check for missing pedidos
    const foundIds = new Set((pedidos ?? []).map((p) => p.id));
    const missingIds = pedido_ids.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      return NextResponse.json(
        { error: "pedidos não encontrados", pedido_ids: missingIds },
        { status: 404 },
      );
    }

    // `pendente_realocacao` = wave bloqueada aguardando resolução de realocações.
    // Iniciar contornaria o gate, então 409. (Fase 1.5/1.6 — 2026-05-28: o parcial
    // NÃO transita mais automaticamente pra este estado; cascade-esgota vai pra
    // Compras ou oferece encaminhar-first. Logo este 409 só ocorre em dado legado
    // ou ação admin via voltar-etapa.) Caminho de saída claro: ENCAMINHAR pra
    // outro galpão (a rota /separacao/encaminhar aceita pendente_realocacao) ou
    // resolver/cancelar as realocações pendentes.
    const pendenteRealocacao = (pedidos ?? []).filter(
      (p) => p.status_separacao === "pendente_realocacao",
    );
    if (pendenteRealocacao.length > 0) {
      return NextResponse.json(
        {
          error: "pedido_em_pendente_realocacao",
          message:
            "Pedido travado em realocação. Saída: encaminhe pra outro galpão, ou " +
            "resolva/cancele as realocações pendentes — depois inicie de novo.",
          acoes_disponiveis: ["encaminhar", "cancelar_realocacao"],
          pedido_ids: pendenteRealocacao.map((p) => p.id),
        },
        { status: 409 },
      );
    }

    // Validate all have an allowed status (aguardando_separacao,
    // aguardando_compra, em_separacao for resume, validacao_oc).
    // `pendente_realocacao` removido — tratado acima com 409 dedicado.
    const ALLOWED_STATUSES = [
      "aguardando_separacao",
      "aguardando_compra",
      "em_separacao",
      "validacao_oc",
    ];
    const invalidPedidos = (pedidos ?? []).filter(
      (p) => !ALLOWED_STATUSES.includes(p.status_separacao),
    );
    if (invalidPedidos.length > 0) {
      return NextResponse.json(
        {
          error: "todos os pedidos devem estar com status 'aguardando_separacao', 'aguardando_compra', 'validacao_oc' ou 'em_separacao'",
          pedido_ids: invalidPedidos.map((p) => p.id),
          statuses: invalidPedidos.map((p) => p.status_separacao),
        },
        { status: 400 },
      );
    }

    // 2. Update pedidos to em_separacao (skip already em_separacao)
    // BLINDAGEM: pedidos with pending compra items NEVER transition to em_separacao.
    // They stay in aguardando_compra and only advance via concluir-oc.
    const { data: pendingCompraRows } = await supabase
      .from("siso_pedido_itens")
      .select("pedido_id")
      .in("pedido_id", pedido_ids)
      .in("compra_status", ["aguardando_compra", "comprado"]);

    const pedidosWithPendingCompra = new Set(
      (pendingCompraRows ?? []).map((r) => r.pedido_id),
    );

    const toStart = (pedidos ?? [])
      .filter(
        (p) =>
          (p.status_separacao === "aguardando_separacao" || p.status_separacao === "validacao_oc") &&
          !pedidosWithPendingCompra.has(p.id),
      )
      .map((p) => p.id);

    if (toStart.length > 0) {
      const { error: updateError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "em_separacao",
          separacao_operador_id: operador_id,
          separacao_iniciada_em: new Date().toISOString(),
        })
        .in("id", toStart)
        .in("status_separacao", ["aguardando_separacao", "validacao_oc"]);

      if (updateError) {
        logger.error("separacao-iniciar", "Failed to update pedidos", {
          error: updateError.message,
        });
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }
    }

    // 2.5 Re-rota OC→própria no clique SEPARAR: se entrou saldo PICKÁVEL desde
    // que o item virou OC, o reconciliador limpa compra_status, cria reserva e
    // marca decisao_final='propria' — o item some do balde "Itens OC" e vira
    // linha normal na wave atual. Roda DEPOIS do promote (acima) pra tratar
    // tanto pedidos recém-promovidos quanto os já em_separacao pelo mesmo
    // caminho (reconciliador agora enxerga em_separacao). Idempotente e atômico
    // (CLAIM compare-and-swap dentro do reconciliador); no-op se não houver item
    // OC ou saldo livre. Best-effort: falha não bloqueia o iniciar.
    try {
      const { data: ocItems } = await supabase
        .from("siso_pedido_itens")
        .select("sku, siso_pedidos!inner(separacao_galpao_id)")
        .in("pedido_id", pedido_ids)
        .in("compra_status", ["oc_pendente", "aguardando_compra"]);

      if (ocItems && ocItems.length > 0) {
        const { reconciliarEntradaEstoque, paresProdutoGalpao } = await import(
          "@/lib/wms/reconciliador-oc"
        );
        // sku → produto_uuid (siso_produtos.id); o reconciliador recebe UUID,
        // NÃO o tiny_produto_id de siso_pedido_itens.produto_id.
        const skus = [
          ...new Set(
            ocItems
              .map((i) => i.sku as string | null)
              .filter((s): s is string => !!s),
          ),
        ];
        const { data: prods } = await supabase
          .from("siso_produtos")
          .select("id, sku")
          .in("sku", skus);
        const skuToUuid = new Map<string, string>(
          (prods ?? []).map((p) => [p.sku as string, p.id as string]),
        );
        const itensNorm = ocItems.map((i) => {
          const pedRaw = i.siso_pedidos as unknown;
          const ped = Array.isArray(pedRaw)
            ? (pedRaw[0] as { separacao_galpao_id?: string | null } | undefined)
            : (pedRaw as { separacao_galpao_id?: string | null } | null);
          return {
            sku: (i.sku as string | null) ?? null,
            galpao_id: ped?.separacao_galpao_id ?? null,
          };
        });
        for (const { produtoId, galpaoId } of paresProdutoGalpao(
          itensNorm,
          skuToUuid,
        )) {
          try {
            await reconciliarEntradaEstoque({ produtoId, galpaoId });
          } catch (recErr) {
            logger.warn(
              "separacao-iniciar",
              "reconciliar OC no clique separar falhou",
              {
                produtoId,
                galpaoId,
                error: recErr instanceof Error ? recErr.message : String(recErr),
              },
            );
          }
        }
      }
    } catch (ocErr) {
      logger.warn("separacao-iniciar", "varredura OC no iniciar falhou (não-fatal)", {
        error: ocErr instanceof Error ? ocErr.message : String(ocErr),
      });
    }

    // 3D (Fase 3): mini-swap intra-galpão removido — saldo é fungível por
    // (produto, galpão), então não há por que consolidar empresas em uma loc
    // canônica antes da wave. Pool físico já é unificado.

    // 3. Call RPC to get consolidated product list for wave picking
    const { data: produtos, error: rpcError } = await supabase.rpc(
      "siso_consolidar_produtos_separacao",
      { p_pedido_ids: pedido_ids, p_order_by: "localizacao" },
    );

    if (rpcError) {
      logger.error("separacao-iniciar", "RPC consolidar failed", {
        error: rpcError.message,
      });
      // Orders are already updated — return them without products
      return NextResponse.json(
        { error: rpcError.message },
        { status: 500 },
      );
    }

    const consolidados: ProdutoConsolidado[] = (produtos ?? []).map(
      (p: Record<string, unknown>) => ({
        produto_id: String(p.produto_id),
        descricao: String(p.descricao ?? ""),
        sku: String(p.sku ?? ""),
        gtin: p.gtin ? String(p.gtin) : null,
        quantidade_total: Number(p.quantidade_total),
        unidade: String(p.unidade ?? "UN"),
        localizacao: p.localizacao ? String(p.localizacao) : null,
      }),
    );

    registrarEventos(
      pedido_ids.map((pid) => ({
        pedidoId: pid,
        evento: "separacao_iniciada" as const,
        usuarioId: operador_id,
        usuarioNome: session.nome,
        detalhes: { qtdPedidos: pedido_ids.length, qtdProdutos: consolidados.length },
      })),
    ).catch(() => {});

    logger.info("separacao-iniciar", "Separação iniciada", {
      pedido_ids,
      operador_id,
      produtos_count: consolidados.length,
    });

    return NextResponse.json({ pedido_ids, produtos: consolidados });
  } catch (err) {
    logger.error("separacao-iniciar", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

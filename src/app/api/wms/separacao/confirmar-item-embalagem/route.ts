import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { buscarEImprimirEtiqueta, imprimirEtiquetaDireta } from "@/lib/etiqueta-service";
import { registrarEvento } from "@/lib/historico-service";
import { kickWorker } from "@/lib/execution-worker";
import { dispararCutoverSePronto } from "@/lib/wms/cutover";

/**
 * POST /api/separacao/confirmar-item-embalagem
 *
 * Manually confirm item quantities during packing via +/- buttons.
 * Increments quantidade_bipada and checks pedido completion.
 *
 * Headers: X-Session-Id
 * Body: { pedido_item_id: string, quantidade: number }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body ||
    !body.pedido_item_id ||
    typeof body.quantidade !== "number"
  ) {
    return NextResponse.json(
      { error: "'pedido_item_id' (string) e 'quantidade' (number) sao obrigatorios" },
      { status: 400 },
    );
  }

  const pedido_item_id: string = body.pedido_item_id;
  const quantidade: number = body.quantidade;

  const supabase = createServiceClient();

  try {
    // Fetch the item to get current state
    const { data: item, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, quantidade_pedida, quantidade_bipada, bipado_completo")
      .eq("id", pedido_item_id)
      .single();

    if (fetchError || !item) {
      return NextResponse.json(
        { error: "Item nao encontrado" },
        { status: 404 },
      );
    }

    // Validate parent pedido is separado or aguardando_compra (OC direct packing)
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao, empresa_origem_id, etiqueta_zpl, etiqueta_url, separacao_tags, separacao_galpao_id")
      .eq("id", item.pedido_id)
      .single();

    if (pedidoError || !pedido) {
      return NextResponse.json(
        { error: "Pedido nao encontrado" },
        { status: 404 },
      );
    }

    const isOC = pedido.status_separacao === "aguardando_compra";

    if (pedido.status_separacao !== "separado" && !isOC) {
      return NextResponse.json(
        {
          error: "Pedido deve estar com status 'separado' ou 'aguardando_compra' para embalagem",
          status_atual: pedido.status_separacao,
        },
        { status: 400 },
      );
    }

    // Calculate new quantidade_bipada (minimum 0)
    const currentBipada = item.quantidade_bipada ?? 0;
    const newBipada = Math.max(0, currentBipada + quantidade);
    const bipado_completo = newBipada >= item.quantidade_pedida;

    // Update the item
    const { error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        quantidade_bipada: newBipada,
        bipado_completo,
      })
      .eq("id", pedido_item_id);

    if (updateError) {
      logger.error("confirmar-item-embalagem", "Failed to update item", {
        error: updateError.message,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    // Check if ALL packable items of this pedido have bipado_completo = true.
    // Exclude indisponivel/cancelado items — they're hidden from the UI and
    // don't need to be packed.
    // NOTE: compra_status is NULL for most items. Using .or() to correctly
    // include NULL values (SQL: NULL NOT IN (...) returns NULL, excluding the row).
    const { count: pendingCount, error: countError } = await supabase
      .from("siso_pedido_itens")
      .select("*", { count: "exact", head: true })
      .eq("pedido_id", item.pedido_id)
      .eq("bipado_completo", false)
      .or("compra_status.is.null,compra_status.not.in.(indisponivel,cancelado)");

    if (countError) {
      logger.error("confirmar-item-embalagem", "Failed to count pending items", {
        error: countError.message,
      });
      return NextResponse.json(
        { error: countError.message },
        { status: 500 },
      );
    }

    const pedido_completo = (pendingCount ?? 0) === 0;

    // If all complete, transition pedido to 'embalado'
    if (pedido_completo) {
      if (isOC) {
        // ── OC resolution: auto-resolve compra + decisao + enqueue + label ──

        // (a) Auto-resolve compra items
        const { data: ocItems } = await supabase
          .from("siso_pedido_itens")
          .select("id, compra_status, compra_quantidade_solicitada")
          .eq("pedido_id", pedido.id)
          .not("compra_status", "is", null)
          .not("compra_status", "in", "(recebido,cancelado)");

        if (ocItems) {
          for (const oci of ocItems) {
            await supabase
              .from("siso_pedido_itens")
              .update({
                compra_status: "recebido",
                compra_quantidade_recebida: oci.compra_quantidade_solicitada ?? 0,
              })
              .eq("id", oci.id);
          }
        }

        // (b) Determine decisao_final
        let decisao: "propria" | "transferencia" = "propria";
        let separacaoGalpaoId: string | null = null;
        let empresaExecId = pedido.empresa_origem_id;

        let pedidoGalpaoId: string | null = null;
        if (pedido.empresa_origem_id) {
          const { data: empresa } = await supabase
            .from("siso_empresas")
            .select("galpao_id")
            .eq("id", pedido.empresa_origem_id)
            .single();
          pedidoGalpaoId = empresa?.galpao_id ?? null;
        }

        const { data: ocOrders } = await supabase
          .from("siso_pedido_itens")
          .select("ordem_compra_id")
          .eq("pedido_id", pedido.id)
          .not("ordem_compra_id", "is", null);

        const ocIds = [...new Set((ocOrders ?? []).map((i) => i.ordem_compra_id).filter(Boolean))];
        let ocGalpaoId: string | null = null;

        if (ocIds.length > 0) {
          const { data: ocs } = await supabase
            .from("siso_ordens_compra")
            .select("galpao_id")
            .in("id", ocIds)
            .limit(1);
          ocGalpaoId = ocs?.[0]?.galpao_id ?? null;
        }

        if (ocGalpaoId && pedidoGalpaoId && ocGalpaoId !== pedidoGalpaoId) {
          decisao = "transferencia";
          separacaoGalpaoId = ocGalpaoId;
          const { data: empresaOcGalpao } = await supabase
            .from("siso_empresas")
            .select("id")
            .eq("galpao_id", ocGalpaoId)
            .eq("ativo", true)
            .order("criado_em", { ascending: true })
            .limit(1)
            .single();
          if (empresaOcGalpao) empresaExecId = empresaOcGalpao.id;
        } else {
          separacaoGalpaoId = pedidoGalpaoId;
        }

        // (c) Update pedido
        const currentTags: string[] = pedido.separacao_tags ?? [];
        const newTags = currentTags.includes("embalagem direta")
          ? currentTags
          : [...currentTags, "embalagem direta"];

        await supabase
          .from("siso_pedidos")
          .update({
            status: "executando",
            status_separacao: "embalado",
            decisao_final: decisao,
            separacao_galpao_id: separacaoGalpaoId,
            embalagem_concluida_em: new Date().toISOString(),
            embalagem_operador_id: session.id,
            separacao_tags: newTags,
          })
          .eq("id", pedido.id);

        // (d) Enqueue execution
        await supabase.from("siso_fila_execucao").insert({
          pedido_id: pedido.id,
          empresa_id: empresaExecId,
          tipo: "lancar_estoque",
          status: "pendente",
          tentativas: 0,
          decisao,
        });

        // (e) Print label
        let etiquetaStatus: "impresso" | "falhou" = "falhou";
        let etiquetaErro: string | null = null;
        try {
          const etiqueta =
            (pedido.etiqueta_zpl || pedido.etiqueta_url) && pedido.empresa_origem_id && separacaoGalpaoId
              ? await imprimirEtiquetaDireta({
                  pedidoId: pedido.id,
                  numero: String(pedido.id),
                  empresaOrigemId: pedido.empresa_origem_id,
                  agrupamentoExpedicaoId: null,
                  etiquetaZpl: pedido.etiqueta_zpl ?? null,
                  etiquetaUrl: pedido.etiqueta_url ?? null,
                  separacaoGalpaoId,
                  separacaoOperadorId: session.id,
                })
              : await buscarEImprimirEtiqueta(pedido.id, session.id);
          etiquetaStatus = etiqueta.success ? "impresso" : "falhou";
          etiquetaErro = etiqueta.error ?? null;
        } catch (err) {
          etiquetaErro = err instanceof Error ? err.message : String(err);
        }

        registrarEvento({
          pedidoId: pedido.id,
          evento: "embalagem_direta_concluida",
          usuarioId: session.id,
          detalhes: { decisao, etiquetaStatus },
        }).catch(() => {});

        kickWorker().catch(() => {});

        // PR-1 safety: só dispara cutover se NF presente. Em OC direta a NF
        // normalmente ainda não existe (vai ser gerada pelo lancar_estoque
        // worker) — pular o callsite aqui evita warn log redundante; o helper
        // será chamado de novo pelo executor após gerar a NF.
        const { data: pedidoCheck } = await supabase
          .from("siso_pedidos")
          .select("nota_fiscal_id")
          .eq("id", pedido.id)
          .single();
        if (!pedidoCheck?.nota_fiscal_id) {
          logger.warn(
            "confirmar-item-embalagem",
            "cutover skipped — NF ausente (OC direta)",
            { pedidoId: pedido.id },
          );
        } else {
          // WMS cutover R→L+S: pedido virou embalado pela embalagem direta OC.
          // Idempotente — helper skipa se já lançado.
          dispararCutoverSePronto(pedido.id).catch((err) => {
            logger.warn(
              "confirmar-item-embalagem",
              "Falha ao disparar cutover (OC direta)",
              {
                pedidoId: pedido.id,
                err: err instanceof Error ? err.message : String(err),
              },
            );
          });
        }

        return NextResponse.json({
          pedido_item_id,
          quantidade_bipada: newBipada,
          bipado_completo,
          pedido_completo,
          etiqueta_status: etiquetaStatus,
          etiqueta_erro: etiquetaErro,
        });
      }

      // ── Normal (separado) completion ──
      const { error: statusError } = await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "embalado",
          embalagem_concluida_em: new Date().toISOString(),
          embalagem_operador_id: session.id,
        })
        .eq("id", item.pedido_id);

      if (statusError) {
        logger.error("confirmar-item-embalagem", "Failed to update pedido status", {
          error: statusError.message,
          pedido_id: item.pedido_id,
        });
      }
    }

    logger.info("confirmar-item-embalagem", "Item confirmado", {
      pedido_item_id,
      quantidade_bipada: newBipada,
      bipado_completo,
      pedido_completo,
    });

    // Record event and await label print when packing is complete (normal flow)
    if (pedido_completo) {
      registrarEvento({
        pedidoId: item.pedido_id,
        evento: "embalagem_concluida",
      }).catch(() => {});

      // PR-1 safety: só dispara cutover se NF presente. Em fluxo normal a NF
      // já existe (foi pré-condição pra entrar em separado), mas o guard
      // explícito evita warn log se algo upstream estiver inconsistente.
      const { data: pedidoCheck } = await supabase
        .from("siso_pedidos")
        .select("nota_fiscal_id")
        .eq("id", item.pedido_id)
        .single();
      if (!pedidoCheck?.nota_fiscal_id) {
        logger.warn(
          "confirmar-item-embalagem",
          "cutover skipped — NF ausente (normal)",
          { pedidoId: item.pedido_id },
        );
      } else {
        // WMS cutover R→L+S: pedido virou embalado. Normalmente já lançado no
        // /concluir (separado) — helper retorna ja_lancado. Idempotente.
        dispararCutoverSePronto(item.pedido_id).catch((err) => {
          logger.warn(
            "confirmar-item-embalagem",
            "Falha ao disparar cutover (normal)",
            {
              pedidoId: item.pedido_id,
              err: err instanceof Error ? err.message : String(err),
            },
          );
        });
      }

      const etiqueta = await buscarEImprimirEtiqueta(item.pedido_id, session.id);
      return NextResponse.json({
        pedido_item_id,
        quantidade_bipada: newBipada,
        bipado_completo,
        pedido_completo,
        etiqueta_status: etiqueta.success ? "impresso" : "falhou",
        etiqueta_erro: etiqueta.error ?? null,
      });
    }

    return NextResponse.json({
      pedido_item_id,
      quantidade_bipada: newBipada,
      bipado_completo,
      pedido_completo,
    });
  } catch (err) {
    logger.error("confirmar-item-embalagem", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

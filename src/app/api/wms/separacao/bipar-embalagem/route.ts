import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { buscarEImprimirEtiqueta, imprimirEtiquetaDireta } from "@/lib/etiqueta-service";
import { registrarEvento } from "@/lib/historico-service";
import { dispararCutoverSePronto } from "@/lib/wms/cutover";
import type { BipEmbalagemResult } from "@/types";

/**
 * POST /api/separacao/bipar-embalagem
 *
 * Process a barcode scan during packing. Calls the PL/pgSQL function
 * siso_processar_bip_embalagem which finds the oldest separado-status
 * order with the scanned SKU and updates quantities atomically.
 *
 * Headers: X-Session-Id
 * Body: { sku: string, galpao_id: string, quantidade?: number }
 * Returns: BipEmbalagemResult
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.sku || typeof body.sku !== "string") {
    return NextResponse.json(
      { error: "'sku' (string) é obrigatório" },
      { status: 400 },
    );
  }
  const sku: string = body.sku.trim().toUpperCase();
  const galpao_id: string | null =
    body.galpao_id && typeof body.galpao_id === "string"
      ? body.galpao_id
      : null;
  const quantidade: number =
    typeof body.quantidade === "number" && body.quantidade > 0
      ? body.quantidade
      : 1;

  const supabase = createServiceClient();

  try {
    const { data, error } = await supabase.rpc(
      "siso_processar_bip_embalagem",
      {
        p_sku: sku,
        p_galpao_id: galpao_id,
        p_quantidade: quantidade,
        p_operador_id: session.id,
        p_strict_qty_pega: true,
      },
    );

    if (error) {
      // Trata 'bipou_alem_do_teto' como erro de domínio (item parcial)
      // — RPC raise EXCEPTION com DETAIL "teto=N,tentado=M".
      const isAlemDoTeto =
        error.message === "bipou_alem_do_teto" ||
        error.message?.includes("bipou_alem_do_teto");
      if (isAlemDoTeto) {
        const detailMatch = (error.details || "").match(/teto=(\d+),tentado=(\d+)/);
        const teto = detailMatch?.[1] ? Number(detailMatch[1]) : null;
        const tentado = detailMatch?.[2] ? Number(detailMatch[2]) : null;
        logger.warn("bipar-embalagem", "Bipou além do teto (item parcial)", {
          sku,
          galpao_id,
          teto,
          tentado,
        });
        return NextResponse.json(
          {
            error: "bipou_alem_do_teto",
            message: `Bipou ${tentado ?? "?"} mas só ${teto ?? "?"} foi pego de fato. Item parcial.`,
            teto,
            tentado,
          },
          { status: 422 },
        );
      }

      logger.error("bipar-embalagem", "RPC error", {
        error: error.message,
        sku,
        galpao_id,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // TABLE-returning functions return empty array when no match found
    if (!data || (Array.isArray(data) && data.length === 0)) {
      // Diagnostic: check WHY the SKU wasn't matched for better user feedback
      let diagnosticMsg = "Nenhum pedido com este SKU pendente de embalagem";

      try {
        type DiagItem = {
          pedido_id: string;
          bipado_completo: boolean;
          compra_status: string | null;
          siso_pedidos: unknown;
        };

        // Check if SKU exists in any pedido (by sku, then by gtin)
        const selectCols =
          "pedido_id, bipado_completo, compra_status, siso_pedidos!inner(numero, status_separacao, separacao_galpao_id)";

        const { data: bySku } = await supabase
          .from("siso_pedido_itens")
          .select(selectCols)
          .eq("sku", sku)
          .limit(5);
        let diagItems = (bySku ?? []) as DiagItem[];

        if (diagItems.length === 0) {
          const { data: byGtin } = await supabase
            .from("siso_pedido_itens")
            .select(selectCols)
            .eq("gtin", sku)
            .limit(5);
          diagItems = (byGtin ?? []) as DiagItem[];
        }

        if (diagItems.length > 0) {
          const reasons: string[] = [];
          for (const item of diagItems) {
            const pedido = item.siso_pedidos as {
              numero: string;
              status_separacao: string;
              separacao_galpao_id: string | null;
            } | null;
            const num = pedido?.numero ?? item.pedido_id;

            if (item.bipado_completo) {
              reasons.push(`#${num}: já bipado`);
            } else if (pedido?.status_separacao !== "separado") {
              reasons.push(`#${num}: status '${pedido?.status_separacao}'`);
            } else if (
              galpao_id &&
              pedido?.separacao_galpao_id &&
              pedido.separacao_galpao_id !== galpao_id
            ) {
              reasons.push(`#${num}: outro galpão`);
            } else if (
              item.compra_status === "cancelado" ||
              item.compra_status === "indisponivel"
            ) {
              reasons.push(`#${num}: item ${item.compra_status}`);
            }
          }

          if (reasons.length > 0) {
            diagnosticMsg = `SKU encontrado mas não disponível: ${reasons.slice(0, 3).join(", ")}`;
          }
        }
      } catch {
        // Diagnostic failed — use default message
      }

      return NextResponse.json(
        { error: diagnosticMsg },
        { status: 404 },
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    const result: BipEmbalagemResult = {
      pedido_id: row.pedido_id,
      produto_id: row.produto_id,
      quantidade_bipada: row.quantidade_bipada,
      bipado_completo: row.bipado_completo,
      pedido_completo: row.pedido_completo,
    };

    logger.info("bipar-embalagem", "Bip processado", {
      sku,
      galpao_id,
      ...result,
    });

    // Record event and await label print when packing is complete
    if (result.pedido_completo) {
      registrarEvento({
        pedidoId: result.pedido_id,
        evento: "embalagem_concluida",
        detalhes: { sku, galpao_id },
      }).catch(() => {});

      // PR-1 safety: só dispara cutover quando NF está emitida E todos os itens
      // estão picados. Sem essa dupla checagem, RPC `pedido_completo=true` pode
      // disparar mesmo quando algum item OC veio sem qty_solicitada cumprida.
      // O helper `dispararCutoverSePronto` já gate por NF internamente, mas
      // o defense-in-depth aqui evita logs de warn em sequência e deixa o
      // contrato explícito no callsite.
      const { data: pedidoComp } = await supabase
        .from("siso_pedidos")
        .select("nota_fiscal_id, chave_acesso_nf")
        .eq("id", result.pedido_id)
        .single();
      const nfPresente = !!(
        pedidoComp?.nota_fiscal_id && pedidoComp?.chave_acesso_nf
      );
      // PostgREST .neq trata NULL como FALSE em SQL three-valued (NULL <> 'x'
      // = NULL), o que excluiria itens normais (compra_status IS NULL) da
      // listagem de faltantes — tornando a guarda vacuosa pra pedidos sem OC.
      // Usar .or pra incluir explicitamente NULL (mesmo padrão de
      // confirmar-item-embalagem.ts).
      const { data: faltantes } = await supabase
        .from("siso_pedido_itens")
        .select("id, separacao_marcado, compra_status, quantidade_pega")
        .eq("pedido_id", result.pedido_id)
        .or("compra_status.is.null,compra_status.not.in.(indisponivel,cancelado)")
        .or("separacao_marcado.eq.false,quantidade_pega.is.null");
      const allPicked = (faltantes ?? []).length === 0;
      if (nfPresente && allPicked) {
        // WMS cutover R→L+S: pedido virou embalado (forward set).
        // Helper é idempotente — em modo Tiny não faz nada.
        dispararCutoverSePronto(result.pedido_id).catch((err) => {
          logger.warn("bipar-embalagem", "Falha ao disparar cutover", {
            pedidoId: result.pedido_id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        logger.info("bipar-embalagem", "cutover skipped — guarda dupla", {
          pedidoId: result.pedido_id,
          nfPresente,
          allPicked,
        });
      }

      // Fast path: bip RPC already claimed the etiqueta and returned print fields
      // Slow path: claim wasn't included (already claimed elsewhere) → fall back to full flow
      const etiqueta = row.etiqueta_empresa_origem_id && row.etiqueta_galpao_id
        ? await imprimirEtiquetaDireta({
            pedidoId: result.pedido_id,
            numero: row.etiqueta_numero ?? result.pedido_id,
            empresaOrigemId: row.etiqueta_empresa_origem_id,
            agrupamentoExpedicaoId: row.etiqueta_agrupamento_id ?? null,
            etiquetaZpl: row.etiqueta_zpl ?? null,
            etiquetaUrl: row.etiqueta_url ?? null,
            separacaoGalpaoId: row.etiqueta_galpao_id,
            separacaoOperadorId: session.id,
          })
        : await buscarEImprimirEtiqueta(result.pedido_id, session.id);

      return NextResponse.json({
        ...result,
        etiqueta_status: etiqueta.success ? "impresso" : "falhou",
        etiqueta_erro: etiqueta.error ?? null,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error("bipar-embalagem", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

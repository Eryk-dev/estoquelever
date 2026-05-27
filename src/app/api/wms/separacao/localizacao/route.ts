import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { atualizarLocalizacaoProduto } from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { getSessionUser } from "@/lib/session";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { wmsAsSource } from "@/lib/wms/flags";
import { resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";

/**
 * POST /api/wms/separacao/localizacao
 *
 * Updates a product's warehouse location (localização) in Tiny ERP, in the
 * local DB snapshot (siso_pedido_item_estoques), AND in siso_estoque (3D) via
 * mov par S+E (origem_tipo='transferencia_localizacao') quando WMS_AS_SOURCE.
 *
 * Body: {
 *   produto_id: number (Tiny bigint),
 *   localizacao: string (new loc code),
 *   empresa_id: string,
 *   galpao_id?: string (preferred; resolved from empresa if absent)
 * }
 * Returns: { ok: true, transferencias: number }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  const produtoId = body?.produto_id;
  const localizacao = body?.localizacao;
  const empresaId = body?.empresa_id;
  let galpaoId: string | null = body?.galpao_id ?? null;

  if (!produtoId || typeof produtoId !== "number") {
    return NextResponse.json(
      { error: "Campo 'produto_id' (number) obrigatorio" },
      { status: 400 },
    );
  }
  if (typeof localizacao !== "string") {
    return NextResponse.json(
      { error: "Campo 'localizacao' (string) obrigatorio" },
      { status: 400 },
    );
  }
  if (!empresaId || typeof empresaId !== "string") {
    return NextResponse.json(
      { error: "Campo 'empresa_id' (string) obrigatorio" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const trimmed = localizacao.trim();

  try {
    // 1. Update in Tiny ERP
    const { token } = await getValidTokenByEmpresa(empresaId);
    await runWithEmpresa(empresaId, () =>
      atualizarLocalizacaoProduto(token, produtoId, trimmed),
    );

    // 2. Update all rows in siso_pedido_item_estoques for this product+empresa
    const { error: dbError } = await supabase
      .from("siso_pedido_item_estoques")
      .update({ localizacao: trimmed || null })
      .eq("produto_id", produtoId)
      .eq("empresa_id", empresaId);

    if (dbError) {
      logger.warn("localizacao", "Tiny updated but DB update failed", {
        produtoId,
        empresaId,
        error: dbError.message,
      });
    }

    // 3. WMS — transferir saldos pra nova loc via mov par S+E
    let transferencias = 0;
    if (wmsAsSource() && trimmed) {
      if (!galpaoId) {
        const { data: pref } = await supabase
          .from("siso_empresa_galpoes_preferenciais")
          .select("galpao_id")
          .eq("empresa_id", empresaId)
          .limit(1)
          .maybeSingle();
        galpaoId = (pref?.galpao_id as string | null) ?? null;
      }
      if (galpaoId) {
        const { data: map } = await supabase
          .from("siso_produto_empresas")
          .select("produto_id")
          .eq("empresa_id", empresaId)
          .eq("tiny_produto_id", Number(produtoId))
          .maybeSingle();
        const produtoWmsId = map?.produto_id as string | undefined;
        if (produtoWmsId) {
          const novaLocId = await resolverLocalizacaoWms(galpaoId, trimmed);
          const { data: sources } = await supabase
            .from("siso_estoque")
            .select("localizacao_id, saldo, reservado")
            .eq("produto_id", produtoWmsId)
            .eq("galpao_id", galpaoId)
            .gt("saldo", 0);
          for (const src of sources ?? []) {
            if (src.localizacao_id === novaLocId) continue;
            const qty = Number(src.saldo);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            // TODO(#2.7-followup): src com reservado > 0 vai falhar a S
            // (validarCoerencia reservado_posterior > saldo_posterior=0).
            // Por ora: catch absorve e loga; operador deve mover loc só sem R
            // ativa. Fix completo (libera R + reemite no destino) fica pro P3/P6.
            const origemId = crypto.randomUUID();
            try {
              await inserirMovimentacao({
                tripla: {
                  produto_id: produtoWmsId,
                  galpao_id: galpaoId,
                  localizacao_id: src.localizacao_id as string,
                },
                tipo: "S",
                qty,
                origem_tipo: "transferencia_localizacao",
                origem_id: origemId,
                origem_detalhes: {
                  contexto: "atualizar_localizacao_produto",
                  destino_loc_id: novaLocId,
                },
                usuario_id: session.id,
                motivo: `Mudança de loc — produto ${produtoId} pra ${trimmed}`,
              });
              await inserirMovimentacao({
                tripla: {
                  produto_id: produtoWmsId,
                  galpao_id: galpaoId,
                  localizacao_id: novaLocId,
                },
                tipo: "E",
                qty,
                origem_tipo: "transferencia_localizacao",
                origem_id: origemId,
                origem_detalhes: {
                  contexto: "atualizar_localizacao_produto",
                  origem_loc_id: src.localizacao_id,
                },
                usuario_id: session.id,
              });
              transferencias++;
            } catch (transferErr) {
              logger.logError({
                error:
                  transferErr instanceof Error
                    ? transferErr
                    : new Error(String(transferErr)),
                source: "localizacao",
                message: "transferencia_localizacao falhou (provavelmente reservado > 0)",
                category: "business_logic",
                metadata: {
                  produtoId,
                  galpaoId,
                  src_loc_id: src.localizacao_id,
                  saldo: src.saldo,
                  reservado: src.reservado,
                },
              });
            }
          }
        }
      }
    }

    logger.info("localizacao", "Localizacao atualizada", {
      produtoId,
      empresaId,
      localizacao: trimmed,
      transferencias,
    });

    return NextResponse.json({ ok: true, transferencias });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("localizacao", "Erro ao atualizar localizacao", {
      produtoId,
      empresaId,
      error: msg,
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

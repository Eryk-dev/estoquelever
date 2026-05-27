import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { atualizarLocalizacaoProduto } from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { getSessionUser } from "@/lib/session";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
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
            const srcLocId = src.localizacao_id as string;
            const origemId = crypto.randomUUID();

            try {
              // Fix-Final A T17 (#2.7): se a loc origem tem Rs ativas,
              // libera ANTES da S — senão validarCoerencia falha
              // (reservado_posterior > saldo_posterior=0). Depois da
              // transferência, reemite Rs no destino preservando TTL.
              const { data: rsAtivasRaw } = await supabase
                .from("siso_movimentacoes")
                .select("id, quantidade, expira_em, origem_id")
                .eq("tipo", "R")
                .eq("produto_id", produtoWmsId)
                .eq("galpao_id", galpaoId)
                .eq("localizacao_id", srcLocId);

              type RAtiva = { id: string; quantidade: number; expira_em: string | null; origem_id: string | null };
              const candidatas = (rsAtivasRaw ?? []) as RAtiva[];

              // Filtra só Rs ainda não estornadas + não expiradas
              const rIds = candidatas.map((r) => r.id);
              const { data: jaLiberadasRaw } = rIds.length
                ? await supabase
                    .from("siso_movimentacoes")
                    .select("estorno_de")
                    .in("estorno_de", rIds)
                    .eq("tipo", "L")
                : { data: [] as Array<{ estorno_de: string }> };
              const liberadasSet = new Set<string>(
                (jaLiberadasRaw ?? []).map((j) => j.estorno_de as string),
              );
              const agora = Date.now();
              const rsAtivas = candidatas.filter((r) => {
                if (liberadasSet.has(r.id)) return false;
                if (!r.expira_em) return true;
                return new Date(r.expira_em).getTime() > agora;
              });

              // 1. Libera Rs ativas
              const rsParaReemitir: Array<{ qty: number; ttlHoras: number; pedido_id: string | null }> = [];
              for (const r of rsAtivas) {
                await estornarReservaIndividual({
                  reserva_id: r.id,
                  motivo: "localizacao_move",
                  usuario_id: session.id,
                });
                const ttlHoras = r.expira_em
                  ? Math.max(1, Math.ceil((new Date(r.expira_em).getTime() - agora) / 3_600_000))
                  : 48;
                rsParaReemitir.push({ qty: Number(r.quantidade), ttlHoras, pedido_id: r.origem_id });
              }

              // 2. Move saldo via par S+E
              await inserirMovimentacao({
                tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: srcLocId },
                tipo: "S",
                qty,
                origem_tipo: "transferencia_localizacao",
                origem_id: origemId,
                origem_detalhes: { contexto: "atualizar_localizacao_produto", destino_loc_id: novaLocId },
                usuario_id: session.id,
                motivo: `Mudança de loc — produto ${produtoId} pra ${trimmed}`,
              });
              await inserirMovimentacao({
                tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: novaLocId },
                tipo: "E",
                qty,
                origem_tipo: "transferencia_localizacao",
                origem_id: origemId,
                origem_detalhes: { contexto: "atualizar_localizacao_produto", origem_loc_id: srcLocId },
                usuario_id: session.id,
              });
              transferencias++;

              // 3. Reemite Rs no destino preservando TTL e pedido_id
              for (const r of rsParaReemitir) {
                if (!r.pedido_id) continue; // R sem origem_id é anômala; pula
                await reservarAtomico({
                  tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: novaLocId },
                  qty: r.qty,
                  pedido_id: r.pedido_id,
                  ttl_horas: r.ttlHoras,
                  usuario_id: session.id,
                });
              }
            } catch (transferErr) {
              logger.logError({
                error:
                  transferErr instanceof Error
                    ? transferErr
                    : new Error(String(transferErr)),
                source: "localizacao",
                message: "transferencia_localizacao falhou em Rs/move/reemit",
                category: "business_logic",
                metadata: {
                  produtoId,
                  galpaoId,
                  src_loc_id: srcLocId,
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

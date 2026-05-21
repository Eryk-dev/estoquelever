import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";
import { obterNotaFiscal } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { criarAgrupamentoFase1 } from "@/lib/agrupamento-service";

const NF_AUTORIZADA = [6, 7]; // 6=Autorizada, 7=Emitida Danfe

/**
 * POST /api/separacao/forcar-pendente
 *
 * Admin-only: force multiple orders from aguardando_nf → aguardando_separacao.
 * Consults Tiny API for each pedido to verify NF is authorized.
 *
 * Body: { pedido_ids: string[] }
 * Headers: X-Session-Id (for auth)
 */
export async function POST(request: NextRequest) {
  // Auth: admin only
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  // AUTH check: ação admin-only (forçar pendente bypassa validação de NF).
  if (!userCan(session, "separacao.administrar")) {
    return NextResponse.json(
      { error: "sem permissão pra forçar pendente" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);

  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids } = body as { pedido_ids: string[] };
  const supabase = createServiceClient();

  try {
    // Fetch pedidos that are in aguardando_nf with nota_fiscal_id
    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, nota_fiscal_id, empresa_origem_id")
      .in("id", pedido_ids)
      .eq("status_separacao", "aguardando_nf");

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    if (!pedidos || pedidos.length === 0) {
      return NextResponse.json({
        ok: true,
        pedidos_atualizados: [],
        pedidos_nf_nao_autorizada: [],
        pedidos_sem_nf: [],
        total: 0,
      });
    }

    const updatedIds: string[] = [];
    const naoAutorizados: Array<{ id: string; situacao: number | null }> = [];
    const semNf: string[] = [];

    for (const pedido of pedidos) {
      if (!pedido.nota_fiscal_id || !pedido.empresa_origem_id) {
        semNf.push(pedido.id);
        continue;
      }

      try {
        const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
        const nf = await runWithEmpresa(pedido.empresa_origem_id, () =>
          obterNotaFiscal(token, Number(pedido.nota_fiscal_id)),
        );

        if (!NF_AUTORIZADA.includes(Number(nf.situacao))) {
          naoAutorizados.push({ id: pedido.id, situacao: nf.situacao ?? null });
          continue;
        }

        // NF authorized — transition
        const { error: updateError } = await supabase
          .from("siso_pedidos")
          .update({
            status_separacao: "aguardando_separacao",
            chave_acesso_nf: nf.chaveAcesso ?? null,
          })
          .eq("id", pedido.id)
          .eq("status_separacao", "aguardando_nf");

        if (!updateError) {
          updatedIds.push(pedido.id);
          // Attempt fase-1 agrupamento (fire-and-forget, never fails the admin action)
          if (nf.chaveAcesso) {
            criarAgrupamentoFase1(pedido.id).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn("separacao-forcar-pendente", "Falha ao consultar NF no Tiny", {
          pedidoId: pedido.id,
          notaFiscalId: pedido.nota_fiscal_id,
          error: err instanceof Error ? err.message : String(err),
        });
        naoAutorizados.push({ id: pedido.id, situacao: null });
      }
    }

    if (updatedIds.length > 0) {
      registrarEventos(
        updatedIds.map((pid) => ({
          pedidoId: pid,
          evento: "nf_autorizada" as const,
          usuarioId: session.id,
          usuarioNome: session.nome,
          detalhes: { forcado: true, verificado_tiny: true },
        })),
      ).catch(() => {});
    }

    logger.info("separacao", "Forçar pendente com verificação NF", {
      autorizados: updatedIds,
      nao_autorizados: naoAutorizados,
      sem_nf: semNf,
      admin: session.nome,
    });

    return NextResponse.json({
      ok: true,
      pedidos_atualizados: updatedIds,
      pedidos_nf_nao_autorizada: naoAutorizados,
      pedidos_sem_nf: semNf,
      total: updatedIds.length,
    });
  } catch (err) {
    logger.error("separacao-forcar-pendente", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

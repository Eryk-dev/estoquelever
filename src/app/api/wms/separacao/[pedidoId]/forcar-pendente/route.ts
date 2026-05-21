import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { obterNotaFiscal } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { criarAgrupamentoFase1 } from "@/lib/agrupamento-service";

const NF_AUTORIZADA = [6, 7]; // 6=Autorizada, 7=Emitida Danfe

/**
 * PATCH /api/separacao/{pedidoId}/forcar-pendente
 *
 * Admin-only: force an order from aguardando_nf → aguardando_separacao.
 * Consults Tiny API to verify NF is authorized before transitioning.
 *
 * Headers: X-Session-Id
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ pedidoId: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  // AUTH check: ação admin-only (forçar pendente bypassa validação de NF).
  // Proxy: sistema.usuarios — só admin tem no seed.
  // TODO: criar perm separacao.administrar dedicada quando Task 20a sair.
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json(
      { error: "apenas admin pode forçar pendente" },
      { status: 403 },
    );
  }

  const { pedidoId } = await params;

  const supabase = createServiceClient();

  try {
    // 1. Fetch the pedido
    const { data: pedido, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao, nota_fiscal_id, empresa_origem_id")
      .eq("id", pedidoId)
      .single();

    if (fetchError || !pedido) {
      return NextResponse.json(
        { error: "pedido não encontrado" },
        { status: 404 },
      );
    }

    // 2. Validate current status
    if (pedido.status_separacao !== "aguardando_nf") {
      return NextResponse.json(
        {
          error: "pedido não está aguardando NF",
          status_atual: pedido.status_separacao,
        },
        { status: 400 },
      );
    }

    // 3. Check NF authorization via Tiny API
    if (!pedido.nota_fiscal_id || !pedido.empresa_origem_id) {
      return NextResponse.json(
        { error: "pedido sem nota_fiscal_id ou empresa_origem_id" },
        { status: 400 },
      );
    }

    const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
    const nf = await runWithEmpresa(pedido.empresa_origem_id, () =>
      obterNotaFiscal(token, Number(pedido.nota_fiscal_id)),
    );

    if (!NF_AUTORIZADA.includes(Number(nf.situacao))) {
      return NextResponse.json(
        {
          error: "NF não está autorizada",
          situacao: nf.situacao,
          nota_fiscal_id: pedido.nota_fiscal_id,
        },
        { status: 400 },
      );
    }

    // 4. NF authorized — update pedido
    const { error: updateError } = await supabase
      .from("siso_pedidos")
      .update({
        status_separacao: "aguardando_separacao",
        chave_acesso_nf: nf.chaveAcesso ?? null,
      })
      .eq("id", pedidoId)
      .eq("status_separacao", "aguardando_nf");

    if (updateError) {
      logger.error("separacao-forcar-pendente", "Failed to update pedido", {
        error: updateError.message,
        pedidoId,
      });
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    logger.info("separacao-forcar-pendente", "Pedido forçado para aguardando_separacao (NF autorizada)", {
      pedidoId,
      admin: session.nome,
      situacao: nf.situacao,
    });

    // Attempt fase-1 agrupamento (fire-and-forget, never fails the admin action)
    if (nf.chaveAcesso) {
      criarAgrupamentoFase1(pedidoId).catch(() => {});
    }

    return NextResponse.json({ success: true, pedido_id: pedidoId });
  } catch (err) {
    logger.error("separacao-forcar-pendente", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import { findOrCreateOcAberta } from "@/lib/compras-oc";
import { cancelOcIfEmpty } from "@/lib/compras-utils";

/**
 * POST /api/wms/compras/redestinar
 *
 * Troca o galpão de RECEBIMENTO/separação de pedidos OC que ainda não foram
 * recebidos (G2 — "destino editável até a mercadoria chegar"). Por pedido:
 *   1. re-aponta `siso_pedidos.separacao_galpao_id` (o reconciliador-oc casa a
 *      entrada por esse campo → o pedido destrava no galpão novo);
 *   2. move as OCs dos itens já comprados pro galpão novo (find-or-create
 *      race-safe + fecha a OC antiga se esvaziar).
 *
 * Só re-aponta status pré-recebimento (aguardando_compra/validacao_oc/comprado),
 * espelhando o guard de /compras/comprar. NÃO mexe em reservas (OC não reserva).
 *
 * Body: { pedido_ids: string[], galpao_id: string }
 */
const STATUS_REDESTINAVEL = ["aguardando_compra", "validacao_oc", "comprado"];

export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json(
      { error: "Apenas compradores podem redestinar" },
      { status: 403 },
    );
  }

  const body = await request.json();
  const pedidoIds = body.pedido_ids as string[] | undefined;
  const galpaoId = typeof body.galpao_id === "string" ? body.galpao_id : "";

  if (!Array.isArray(pedidoIds) || pedidoIds.length === 0 || !galpaoId) {
    return NextResponse.json(
      { error: "Envie { pedido_ids: [...], galpao_id }" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const redestinados: string[] = [];
  const pulados: { id: string; motivo: string }[] = [];

  for (const pedidoId of pedidoIds) {
    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao, separacao_galpao_id, empresa_origem_id")
      .eq("id", pedidoId)
      .maybeSingle();

    if (!pedido) {
      pulados.push({ id: pedidoId, motivo: "pedido não encontrado" });
      continue;
    }
    if (!STATUS_REDESTINAVEL.includes(pedido.status_separacao ?? "")) {
      pulados.push({
        id: pedidoId,
        motivo: `status ${pedido.status_separacao ?? "null"} não permite redestinar`,
      });
      continue;
    }
    if (pedido.separacao_galpao_id === galpaoId) {
      pulados.push({ id: pedidoId, motivo: "já está nesse galpão" });
      continue;
    }

    // Move as OCs dos itens já comprados pro galpão novo.
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("id, ordem_compra_id")
      .eq("pedido_id", pedidoId)
      .eq("compra_status", "comprado")
      .not("ordem_compra_id", "is", null);

    const ocsAntigas = new Set<string>();
    for (const it of itens ?? []) {
      const ocAntiga = it.ordem_compra_id as string;
      const { data: ocOld } = await supabase
        .from("siso_ordens_compra")
        .select("fornecedor")
        .eq("id", ocAntiga)
        .maybeSingle();
      if (!ocOld) continue;

      const novaOcId = await findOrCreateOcAberta(supabase, {
        fornecedor: ocOld.fornecedor as string,
        galpaoId,
        empresaId: (pedido.empresa_origem_id as string | null) ?? null,
        observacao: `Redestinada — pedido ${pedidoId}`,
      });
      if (!novaOcId || novaOcId === ocAntiga) continue;

      await supabase
        .from("siso_pedido_itens")
        .update({ ordem_compra_id: novaOcId })
        .eq("id", it.id);
      ocsAntigas.add(ocAntiga);
    }

    // Re-aponta o galpão de separação (é por aqui que o reconciliador casa).
    const { error: updErr } = await supabase
      .from("siso_pedidos")
      .update({ separacao_galpao_id: galpaoId })
      .eq("id", pedidoId);

    if (updErr) {
      pulados.push({ id: pedidoId, motivo: updErr.message });
      continue;
    }

    // Fecha as OCs antigas que ficaram vazias.
    for (const ocAntiga of ocsAntigas) {
      await cancelOcIfEmpty(supabase, ocAntiga, "redestinar");
    }

    redestinados.push(pedidoId);
  }

  logger.info("redestinar", "Pedidos redestinados", {
    galpao_id: galpaoId,
    redestinados,
    pulados,
  });

  return NextResponse.json({ ok: true, redestinados, pulados });
}

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string; id: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw, id: idRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  const id = Number(idRaw);
  const isAdmin = (session.cargos ?? [session.cargo]).includes("admin");

  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: veiculo } = await supabase
    .from("siso_produto_veiculos")
    .select("id, produto_sku, adicionado_por")
    .eq("id", id)
    .maybeSingle();

  if (!veiculo || veiculo.produto_sku !== sku) {
    return NextResponse.json({ error: "Veículo não encontrado" }, { status: 404 });
  }

  const podeRemover = isAdmin || veiculo.adicionado_por === session.id;
  if (!podeRemover) {
    return NextResponse.json(
      { error: "Você só pode remover veículos que você cadastrou" },
      { status: 403 },
    );
  }

  const { error: delErr } = await supabase
    .from("siso_produto_veiculos")
    .delete()
    .eq("id", id);

  if (delErr) {
    logger.error("cross-veiculo-del", "Erro ao remover veículo", {
      id,
      error: delErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-veiculo-del", "Veículo removido", {
    usuario: session.id,
    sku,
    id,
  });
  return NextResponse.json({ ok: true });
}

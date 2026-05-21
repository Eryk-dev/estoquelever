import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string; codigo: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw, codigo: codigoRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  const codigo = decodeURIComponent(codigoRaw).trim().toUpperCase();
  // proxy admin-equivalent: só admin tem sistema.usuarios.
  // Operadores podem remover OEMs próprios; só admin remove os de outros.
  const isAdmin = userCan(session, "sistema.usuarios");

  const supabase = createServiceClient();

  const { data: oem } = await supabase
    .from("siso_produto_oems")
    .select("id, origem, adicionado_por")
    .eq("produto_sku", sku)
    .eq("oem_code", codigo)
    .maybeSingle();

  if (!oem) {
    return NextResponse.json({ error: "OEM não encontrado" }, { status: 404 });
  }

  const podeRemover =
    isAdmin || (oem.origem === "manual" && oem.adicionado_por === session.id);

  if (!podeRemover) {
    return NextResponse.json(
      { error: "Você só pode remover OEMs que você cadastrou" },
      { status: 403 },
    );
  }

  const { error: delErr } = await supabase
    .from("siso_produto_oems")
    .delete()
    .eq("id", oem.id);

  if (delErr) {
    logger.error("cross-oem-del", "Erro ao remover OEM", {
      sku,
      codigo,
      error: delErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-oem-del", "OEM removido", {
    usuario: session.id,
    sku,
    codigo,
  });
  return NextResponse.json({ ok: true });
}

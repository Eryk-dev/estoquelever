import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { decidirLigacao } from "@/lib/cross/equivalencias";
import type { CrossStatus } from "@/lib/cross/equivalencias-core";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

const ACOES: Record<string, CrossStatus> = {
  confirmar: "confirmado",
  bloquear: "bloqueado",
  desfazer: "sugestao",
};

/** POST /api/wms/cross/[id]/decidir { acao: confirmar|bloquear|desfazer, observacao? } */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "vendas.aprovar_troca")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id } = await params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  let body: { acao?: string; observacao?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const status = body.acao ? ACOES[body.acao] : undefined;
  if (!status) {
    return NextResponse.json({ error: "acao deve ser confirmar|bloquear|desfazer" }, { status: 400 });
  }

  try {
    await decidirLigacao(createServiceClient(), {
      id: idNum,
      status,
      decididoPor: session.id,
      observacao: body.observacao,
    });
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.decidir", error, message: "erro decidindo ligação" });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { entrarParty, sairParty } from "@/lib/wms/inventario";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";
import { userCan } from "@/lib/permissions";

// POST /api/wms/inventario/[id]/party
// Operador entra na party desta sessão. Idempotente: chamadas repetidas
// pelo mesmo user retornam ok sem duplicar. Auto-inicia a sessão se
// ainda estiver em 'planejada' (requer perm `inventario.iniciar_sessao`).
// Reentrada (após sair) retorna retomado=true e preserva locs_contadas
// acumulada.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    // Pré-flight: se a sessão tá "planejada", entrarParty vai disparar
    // iniciarSessao (transição planejada→em_andamento). Isso é um ato
    // de supervisor — qualquer operador da party não pode arrastar a
    // sessão pra "em_andamento" implicitamente. Exige perm explícita.
    const sb = createServiceClient();
    const { data: sess } = await sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", id)
      .single();
    const status = (sess as { status?: string } | null)?.status ?? null;
    if (status === "planejada" && !userCan(auth.user, "inventario.iniciar_sessao")) {
      return NextResponse.json(
        {
          error:
            "sessão ainda planejada; é preciso permissão inventario.iniciar_sessao pra iniciá-la implicitamente",
        },
        { status: 403 },
      );
    }

    const { retomado } = await entrarParty(id, auth.user.id);
    return NextResponse.json({ ok: true, retomado });
  } catch (e) {
    // [P2-INV-02] auto-start de sessão planejada pode esbarrar em locs já
    // travadas por outra sessão — 409 com os códigos pra UI.
    if ((e as { code?: string }).code === "locs_bloqueadas") {
      return NextResponse.json(
        {
          error: "locs_bloqueadas",
          message: e instanceof Error ? e.message : String(e),
          locs: (e as { locs?: string[] }).locs ?? [],
        },
        { status: 409 },
      );
    }
    return wmsErrorResponse({
      source: "wms.inventario.party.entrar",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/party`,
      requestMethod: "POST",
      metadata: { sessao_id: id, usuario_id: auth.user.id },
    });
  }
}

// DELETE /api/wms/inventario/[id]/party
// Operador (auth.user) sai da party. Locs em em_contagem dele ficam
// até o cleanup cron (siso_inventario_recovery) liberar. Reentrar depois
// preserva locs_contadas.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await sairParty(id, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.inventario.party.sair",
      error: e,
      status: 400,
      requestPath: `/api/wms/inventario/${id}/party`,
      requestMethod: "DELETE",
      metadata: { sessao_id: id, usuario_id: auth.user.id },
    });
  }
}

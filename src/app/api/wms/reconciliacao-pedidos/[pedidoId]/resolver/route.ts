import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * POST /api/wms/reconciliacao-pedidos/[pedidoId]/resolver  (P084)
 * Body: { acao: "saiu" | "cancelado" }
 * Resolve o pedido-fantasma (padrão C): R viva sem saída num pedido forward.
 *   saiu      → converte R→L+S (saída final).
 *   cancelado → devolve à prateleira (R→L) + marca pedido cancelado.
 * Gate: admin (mexe no ledger + status).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pedidoId: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { pedidoId } = await params;
  const body = await req.json().catch(() => null);
  const acao = body?.acao as string | undefined;
  if (acao !== "saiu" && acao !== "cancelado") {
    return NextResponse.json({ error: "acao deve ser 'saiu' ou 'cancelado'" }, { status: 400 });
  }

  const sb = createServiceClient();
  // Empresa vendedora pra tag da S (caso 'saiu'): empresa_origem do pedido.
  const { data: ped } = await sb.from("siso_pedidos").select("empresa_origem_id").eq("id", pedidoId).maybeSingle();
  if (!ped) return NextResponse.json({ error: "pedido não encontrado" }, { status: 404 });

  try {
    const { data, error } = await sb.rpc("wms_resolver_pedido_fantasma", {
      p_pedido_id: pedidoId,
      p_acao: acao,
      p_empresa_vendedora_id: (ped as { empresa_origem_id: string | null }).empresa_origem_id,
      p_usuario_id: auth.user.id,
    });
    if (error) throw error;
    return NextResponse.json({ ok: true, ...(data as object) });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.reconciliacao-pedidos.resolver",
      error: e,
      status: 400,
      requestPath: `/api/wms/reconciliacao-pedidos/${pedidoId}/resolver`,
      requestMethod: "POST",
      metadata: { pedido_id: pedidoId, acao },
    });
  }
}

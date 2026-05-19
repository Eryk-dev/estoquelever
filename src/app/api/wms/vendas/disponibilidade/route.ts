import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";
import { resolverDisponibilidadeVenda } from "@/lib/wms/vendas-disponibilidade";

/**
 * GET /api/wms/vendas/disponibilidade
 *
 * Resolve a melhor (empresa_dona, localização) com saldo disponível pra
 * baixar a venda de um produto num galpão. Usado pela tela /wms/vendas/nova
 * pra exibir a sugestão read-only ao vendedor (ele não precisa escolher
 * empresa dona nem loc).
 *
 * Query params:
 *   - produto_id (uuid, obrigatório)
 *   - galpao_id (uuid, obrigatório)
 *   - empresa_origem_id (uuid, opcional) — tiebreak: prefere baixar da
 *     empresa que vende se ela tem saldo.
 *
 * Resposta: { total_disponivel, sugestao | null }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const produto_id = sp.get("produto_id");
  const galpao_id = sp.get("galpao_id");
  const empresa_origem_id = sp.get("empresa_origem_id") ?? undefined;

  if (!produto_id || !galpao_id) {
    return NextResponse.json(
      { error: "produto_id e galpao_id são obrigatórios" },
      { status: 400 },
    );
  }

  try {
    const sb = createServiceClient();
    const result = await resolverDisponibilidadeVenda(sb as never, {
      produto_id,
      galpao_id,
      empresa_origem_id,
    });
    return NextResponse.json(result);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.vendas.disponibilidade",
      error: e,
      requestPath: "/api/wms/vendas/disponibilidade",
      requestMethod: "GET",
      metadata: { produto_id, galpao_id, empresa_origem_id },
    });
  }
}

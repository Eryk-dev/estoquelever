import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * GET /api/cross/produtos/:sku/has-cross
 *
 * Resposta ultra-leve: { has: boolean, count: number }
 *
 * Usa fecho transitivo do cluster — conta todos os SKUs equivalentes
 * incluindo via cadeia (não só vizinhos diretos).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  if (!sku) {
    return NextResponse.json({ has: false, count: 0 });
  }

  const supabase = createServiceClient();

  const { data } = await supabase.rpc("siso_cross_cluster_skus", {
    p_sku: sku,
  });

  const count = Array.isArray(data) ? data.length : 0;
  return NextResponse.json({ has: count > 0, count });
}

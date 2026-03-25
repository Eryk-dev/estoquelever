import { NextResponse } from "next/server";

/**
 * GET /api/reconciliacao
 *
 * DISABLED — reconciliation was pulling non-marketplace orders into SISO.
 * The Tiny LIST API returns ecommerce data inconsistently, causing
 * internal/manual orders to bypass marketplace filters.
 */
export async function GET() {
  return NextResponse.json(
    {
      error: "Reconciliação desativada",
      reason: "Puxando pedidos sem marketplace vinculado",
    },
    { status: 410 },
  );
}

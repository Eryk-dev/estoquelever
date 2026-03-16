import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/dashboard/counts
 *
 * Lightweight endpoint returning pending counts for each module card.
 */
export async function GET() {
  const supabase = createServiceClient();

  const [siso, separacao, compras] = await Promise.all([
    // SISO: pedidos pendentes awaiting operator decision
    supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .eq("status", "pendente"),
    // Separação: orders in active separation pipeline
    supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .in("status_separacao", [
        "aguardando_separacao",
        "em_separacao",
        "separado",
      ]),
    // Compras: orders awaiting purchase
    supabase
      .from("siso_pedidos")
      .select("*", { count: "exact", head: true })
      .eq("status_separacao", "aguardando_compra"),
  ]);

  return NextResponse.json({
    siso: siso.count ?? 0,
    separacao: separacao.count ?? 0,
    compras: compras.count ?? 0,
  });
}

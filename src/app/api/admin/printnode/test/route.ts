import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { testarConexao } from "@/lib/printnode";

/**
 * POST /api/admin/printnode/test
 * Tests the PrintNode connection using the configured API key.
 * Requires admin cargo (via x-siso-user-id header).
 */
export async function POST(request: NextRequest) {
  // Admin check
  const userId = request.headers.get("x-siso-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("cargo")
    .eq("id", userId)
    .single();

  if (!user || user.cargo !== "admin") {
    return NextResponse.json({ error: "Acesso restrito a administradores" }, { status: 403 });
  }

  // Check env var
  const apiKey = process.env.PRINTNODE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "PRINTNODE_API_KEY não configurada" },
      { status: 500 },
    );
  }

  const result = await testarConexao(apiKey);
  return NextResponse.json(result);
}

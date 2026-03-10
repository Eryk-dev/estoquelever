import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { listarImpressoras } from "@/lib/printnode";

/**
 * GET /api/admin/printnode/printers
 * Lists available PrintNode printers.
 * Requires admin cargo (via x-siso-user-id header).
 */
export async function GET(request: NextRequest) {
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

  try {
    const printers = await listarImpressoras(apiKey);
    return NextResponse.json(printers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

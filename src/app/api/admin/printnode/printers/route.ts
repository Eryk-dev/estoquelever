import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { listarImpressoras } from "@/lib/printnode";
import { getConfig } from "@/lib/config";

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
    .select("cargo, cargos")
    .eq("id", userId)
    .single();

  if (!user || !(user.cargos ?? [user.cargo]).includes("admin")) {
    return NextResponse.json({ error: "Acesso restrito a administradores" }, { status: 403 });
  }

  const apiKey = await getConfig("PRINTNODE_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { error: "API Key do PrintNode não configurada. Adicione na seção Impressão." },
      { status: 400 },
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

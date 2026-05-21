import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { testarConexao } from "@/lib/printnode";

/**
 * POST /api/wms/admin/printnode/contas/[id]/test
 *
 * Testa a key de uma conta específica chamando GET /whoami no PrintNode.
 * Substitui o antigo /api/wms/admin/printnode/test (single-key).
 *
 * Body: opcional `{ api_key }` — pra testar uma key NOVA antes de salvar
 * (botão "testar" no formulário de criação). Se ausente, usa a key salva.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }
  if (!userCan(session, "sistema.conexoes")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const overrideKey =
    typeof body?.api_key === "string" && body.api_key.trim()
      ? body.api_key.trim()
      : null;

  let apiKey = overrideKey;
  if (!apiKey) {
    const { data: conta, error } = await supabase
      .from("siso_printnode_contas")
      .select("api_key, ativo")
      .eq("id", id)
      .single();

    if (error || !conta) {
      return NextResponse.json({ ok: false, error: "Conta não encontrada" }, { status: 404 });
    }
    if (!conta.ativo) {
      return NextResponse.json({ ok: false, error: "Conta inativa" }, { status: 400 });
    }
    apiKey = conta.api_key;
  }

  const result = await testarConexao(apiKey);
  return NextResponse.json(result);
}

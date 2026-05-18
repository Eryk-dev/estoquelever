/**
 * /api/ml/connections/[id]/test — POST faz GET /users/me e atualiza nickname/email
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { testarMlConnection } from "@/lib/ml-api";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const result = await testarMlConnection(id);
  const supabase = createServiceClient();

  if (result.ok) {
    await supabase
      .from("siso_ml_connections")
      .update({
        ultimo_sync_em: new Date().toISOString(),
        ultimo_erro: null,
      })
      .eq("id", id);
    return NextResponse.json({ ok: true, nickname: result.nickname });
  } else {
    await supabase
      .from("siso_ml_connections")
      .update({ ultimo_erro: result.erro ?? "erro desconhecido" })
      .eq("id", id);
    return NextResponse.json({ ok: false, erro: result.erro });
  }
}

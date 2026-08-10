import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** Remove somente o vínculo histórico produto×localização já zerado. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; localizacaoId: string }> },
) {
  const session = await getSessionUser(req);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  if (!session.galpaoPodeEditar) {
    return NextResponse.json({ error: "Galpão disponível somente para visualização" }, { status: 403 });
  }

  const { id: produtoId, localizacaoId } = await params;
  try {
    const sb = createServiceClient();
    const { data: linha, error: readError } = await sb
      .from("siso_estoque")
      .select("id, saldo, reservado, galpao_id")
      .eq("produto_id", produtoId)
      .eq("localizacao_id", localizacaoId)
      .maybeSingle();
    if (readError) throw readError;
    if (!linha) {
      return NextResponse.json({ error: "Localização não vinculada ao produto" }, { status: 404 });
    }
    if (Number(linha.saldo) !== 0 || Number(linha.reservado) !== 0) {
      return NextResponse.json(
        { error: "Só é possível remover uma localização com saldo e reservado zerados" },
        { status: 409 },
      );
    }
    if (session.galpaoId && session.galpaoId !== linha.galpao_id) {
      return NextResponse.json({ error: "Galpão não autorizado" }, { status: 403 });
    }

    const { error } = await sb
      .from("siso_estoque")
      .delete()
      .eq("id", linha.id)
      .eq("saldo", 0)
      .eq("reservado", 0);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return wmsErrorResponse({
      source: "wms.produtos.localizacao.delete",
      error,
      requestPath: `/api/wms/produtos/${produtoId}/localizacoes/${localizacaoId}`,
      requestMethod: "DELETE",
    });
  }
}

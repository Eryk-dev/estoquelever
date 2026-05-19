import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  const sp = req.nextUrl.searchParams;
  let q = sb
    .from("siso_inventario_divergencias")
    .select(
      "*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)",
    )
    .eq("sessao_id", id)
    // delta = 0 não é divergência real — pode ser lixo histórico de versões
    // antigas do computarDivergencias. Esconde sempre.
    .neq("delta", 0);
  const status = sp.get("status");
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) {
    return wmsErrorResponse({
      source: "wms.inventario.divergencias",
      error,
      requestPath: `/api/wms/inventario/${id}/divergencias`,
      requestMethod: "GET",
      metadata: { sessao_id: id },
    });
  }
  return NextResponse.json({ rows: data ?? [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id: sessaoId } = await params;
  const body = await req.json();

  const ids: string[] = Array.isArray(body.divergencia_ids)
    ? body.divergencia_ids.filter((x: unknown): x is string => typeof x === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "divergencia_ids obrigatório (array com ≥1 id)" },
      { status: 400 },
    );
  }

  // Sem "recontagem" no novo fluxo — supervisor decide só aprovar/rejeitar
  // a divergência depois da contagem encerrada.
  const novoStatus =
    body.acao === "aprovar"
      ? "aprovada"
      : body.acao === "rejeitar"
        ? "rejeitada"
        : null;
  if (!novoStatus) {
    return NextResponse.json(
      { error: "acao inválida (use 'aprovar' ou 'rejeitar')" },
      { status: 400 },
    );
  }

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_inventario_divergencias")
    .update({
      status: novoStatus,
      resolucao_por: auth.user.id,
      resolucao_em: new Date().toISOString(),
      observacoes_resolucao: body.observacoes ?? null,
    })
    .in("id", ids)
    .eq("sessao_id", sessaoId)
    .eq("status", "pendente")
    .select("id");

  if (error) {
    return wmsErrorResponse({
      source: "wms.inventario.divergencias",
      error,
      requestPath: `/api/wms/inventario/${sessaoId}/divergencias`,
      requestMethod: "PATCH",
      metadata: { sessao_id: sessaoId, acao: body.acao, ids_count: ids.length },
    });
  }

  return NextResponse.json({ ok: true, atualizadas: data?.length ?? 0 });
}

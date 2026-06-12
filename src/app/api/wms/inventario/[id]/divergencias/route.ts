import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
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

  // [INV-04] Marca perdas que COLIDEM com reserva viva: aplicar a perda
  // deixaria saldo < reservado (CHECK do estoque) e o preflight da RPC de
  // aplicar abortaria a sessão inteira. O badge avisa o supervisor ANTES de
  // ele tentar aplicar — ação: liberar/realocar a reserva ou rejeitar a linha.
  type DivRow = {
    produto_id: string;
    localizacao_id: string;
    delta: number;
    status: string;
    [k: string]: unknown;
  };
  let rows = (data ?? []) as DivRow[];
  const perdas = rows.filter(
    (r) =>
      Number(r.delta) < 0 &&
      (r.status === "pendente" || r.status === "aprovada"),
  );
  if (perdas.length > 0) {
    const { data: est } = await sb
      .from("siso_estoque")
      .select("produto_id, localizacao_id, saldo, reservado")
      .in("produto_id", [...new Set(perdas.map((p) => p.produto_id))])
      .in("localizacao_id", [...new Set(perdas.map((p) => p.localizacao_id))]);
    const estMap = new Map(
      ((est ?? []) as Array<{
        produto_id: string;
        localizacao_id: string;
        saldo: number;
        reservado: number;
      }>).map((e) => [`${e.produto_id}|${e.localizacao_id}`, e]),
    );
    rows = rows.map((r) => {
      if (Number(r.delta) >= 0 || (r.status !== "pendente" && r.status !== "aprovada")) {
        return r;
      }
      const e = estMap.get(`${r.produto_id}|${r.localizacao_id}`);
      if (!e) return r;
      const colide =
        Number(e.saldo) - Math.abs(Number(r.delta)) < Number(e.reservado);
      return colide ? { ...r, colide_reserva: true } : r;
    });
  }

  return NextResponse.json({ rows });
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

  // [INV-02] Sessão presa em 'aprovada' porque 1 divergência aprovada falha na
  // aplicação (ex.: pick consumiu o saldo entre aprovação e aplicação): o
  // supervisor pode REJEITAR a divergência culpada e re-aplicar a sessão.
  // Só pra acao='rejeitar', só com a sessão em 'aprovada', e exige
  // inventario.supervisionar.
  let statusAlvo: string[] = ["pendente"];
  if (novoStatus === "rejeitada") {
    const { data: sessaoRow } = await sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", sessaoId)
      .maybeSingle();
    if ((sessaoRow as { status?: string } | null)?.status === "aprovada") {
      if (!userCan(auth.user, "inventario.supervisionar")) {
        return NextResponse.json(
          {
            error:
              "rejeitar divergência já aprovada exige permissão inventario.supervisionar",
          },
          { status: 403 },
        );
      }
      statusAlvo = ["pendente", "aprovada"];
    }
  }

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
    .in("status", statusAlvo)
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

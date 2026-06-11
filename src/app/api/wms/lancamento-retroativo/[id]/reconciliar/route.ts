import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { reconciliarRetroativo } from "@/lib/wms/movimentacoes";
import { createServiceClient } from "@/lib/supabase-server";

// UUID v1-5 (qualquer versão válida) — mesma forma usada em ledger.assertUuidLike.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth + perm granular (finding 8.9)
  const session = await getSessionUser(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.retroativo")) {
    return NextResponse.json({ error: "forbidden — requer operacoes.retroativo" }, { status: 403 });
  }
  const auth = { user: session };

  const { id } = await params;
  const body = await req.json();
  if (!body.compra_mov_id) {
    return NextResponse.json({ error: "compra_mov_id obrigatório" }, { status: 400 });
  }
  const compraMovId = String(body.compra_mov_id);
  if (!UUID_RE.test(compraMovId)) {
    return NextResponse.json(
      { error: "compra_mov_id não é um uuid válido" },
      { status: 400 },
    );
  }

  // qty_estorno: ausente/null → undefined (clamp default). Presente mas não
  // finito > 0 → 400 (evita NaN→null→estorno TOTAL silencioso).
  let qtyEstorno: number | undefined = undefined;
  if (body.qty_estorno != null) {
    const n = Number(body.qty_estorno);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        { error: "qty_estorno inválido (deve ser número > 0)" },
        { status: 400 },
      );
    }
    qtyEstorno = n;
  }

  // Existência + validação: a compra_mov precisa ser uma entrada (E) de origem
  // de compra, do MESMO produto do lançamento retroativo alvo. Sem isso, um
  // reconciliar poderia estornar uma mov arbitrária de outro produto/tipo.
  const sb = createServiceClient();
  const { data: retroRow, error: retroErr } = await sb
    .from("siso_movimentacoes")
    .select("id, produto_id")
    .eq("id", id)
    .maybeSingle();
  if (retroErr) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo.reconciliar",
      error: retroErr,
      status: 500,
      requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
      requestMethod: "POST",
      metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
    });
  }
  if (!retroRow) {
    return NextResponse.json(
      { error: `retroativo_mov_id ${id} não existe em siso_movimentacoes` },
      { status: 404 },
    );
  }

  const { data: compraRow, error: compraErr } = await sb
    .from("siso_movimentacoes")
    .select("id, tipo, produto_id, origem_tipo")
    .eq("id", compraMovId)
    .maybeSingle();
  if (compraErr) {
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo.reconciliar",
      error: compraErr,
      status: 500,
      requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
      requestMethod: "POST",
      metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
    });
  }
  if (!compraRow) {
    return NextResponse.json(
      { error: `compra_mov_id ${compraMovId} não existe em siso_movimentacoes` },
      { status: 404 },
    );
  }
  if (compraRow.tipo !== "E") {
    return NextResponse.json(
      { error: "mov_invalida", message: `compra_mov_id deve ser uma entrada (tipo='E'), recebido tipo='${compraRow.tipo}'` },
      { status: 400 },
    );
  }
  if (compraRow.produto_id !== retroRow.produto_id) {
    return NextResponse.json(
      { error: "mov_invalida", message: "compra_mov_id é de outro produto — não corresponde ao lançamento retroativo alvo" },
      { status: 400 },
    );
  }
  if (
    compraRow.origem_tipo !== "nf_compra" &&
    compraRow.origem_tipo !== "lancamento_retroativo"
  ) {
    return NextResponse.json(
      { error: "mov_invalida", message: `compra_mov_id tem origem_tipo='${compraRow.origem_tipo}' — só 'nf_compra' ou 'lancamento_retroativo' podem reconciliar` },
      { status: 400 },
    );
  }

  try {
    const r = await reconciliarRetroativo({
      retroativo_mov_id: id,
      compra_mov_id: compraMovId,
      usuario_id: auth.user.id,
      qty_estorno: qtyEstorno,
    });
    if (r.idempotente) {
      return NextResponse.json({ ok: true, idempotente: true, mensagem: "lançamento já reconciliado" });
    }
    return NextResponse.json({ ok: true, qty_estornada: r.qtyEstornada, parcial: r.parcial });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isSemSaldo = /sem saldo disponível/i.test(msg);
    return wmsErrorResponse({
      source: "wms.lancamento-retroativo.reconciliar",
      error: e,
      status: isSemSaldo ? 409 : 400,
      requestPath: `/api/wms/lancamento-retroativo/${id}/reconciliar`,
      requestMethod: "POST",
      metadata: { retroativo_mov_id: id, compra_mov_id: compraMovId },
    });
  }
}

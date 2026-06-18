import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

const REQ_PATH = "/api/wms/separacao/produto-localizacoes";

/**
 * GET /api/wms/separacao/produto-localizacoes?sku=<sku>&galpao_id=<uuid>
 *
 * Histórico de localizações de um produto NO galpão de separação: todos os
 * locais pelos quais ele já passou (siso_movimentacoes), incluindo os hoje
 * zerados, anotados com o saldo atual (siso_estoque). Serve à validação dos
 * itens OC no checklist — quando o saldo do sistema diverge do físico, o
 * operador vê onde a peça já esteve e vai procurar lá.
 *
 * Resolve o produto por SKU (UNIQUE em siso_produtos) — o checklist já carrega
 * o sku efetivo (peça física), evitando o gotcha de produto_id=tiny_produto_id.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sku = searchParams.get("sku")?.trim();
  const galpaoId = searchParams.get("galpao_id")?.trim();

  if (!sku) {
    return NextResponse.json({ error: "'sku' é obrigatório" }, { status: 400 });
  }
  if (!galpaoId) {
    return NextResponse.json(
      { error: "'galpao_id' é obrigatório" },
      { status: 400 },
    );
  }

  const sb = createServiceClient();

  // produto WMS por SKU (UNIQUE). Sem match → sem histórico (não é erro).
  const { data: produto, error: errProd } = await sb
    .from("siso_produtos")
    .select("id")
    .eq("sku", sku)
    .maybeSingle();
  if (errProd) {
    return wmsErrorResponse({
      source: "wms.separacao.produto-localizacoes",
      error: errProd,
      requestPath: REQ_PATH,
      requestMethod: "GET",
    });
  }
  if (!produto) return NextResponse.json({ rows: [] });

  const produtoId = produto.id as string;

  // Locais distintos pelos quais o produto passou no galpão (últimas 300 movs).
  const { data: movs, error: errMov } = await sb
    .from("siso_movimentacoes")
    .select("localizacao_id, criado_em")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId)
    .not("localizacao_id", "is", null)
    .order("criado_em", { ascending: false })
    .limit(300);
  if (errMov) {
    return wmsErrorResponse({
      source: "wms.separacao.produto-localizacoes",
      error: errMov,
      requestPath: REQ_PATH,
      requestMethod: "GET",
    });
  }

  // Dedup por localizacao_id: 1ª ocorrência = última mov (vem desc); conta movs.
  const porLoc = new Map<string, { ultima_movimentacao: string; movs: number }>();
  for (const m of movs ?? []) {
    const locId = m.localizacao_id as string | null;
    if (!locId) continue;
    const ex = porLoc.get(locId);
    if (ex) ex.movs += 1;
    else porLoc.set(locId, { ultima_movimentacao: m.criado_em as string, movs: 1 });
  }

  // Saldo atual por loc (siso_estoque).
  const { data: estoque, error: errEst } = await sb
    .from("siso_estoque")
    .select("localizacao_id, saldo, disponivel")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId);
  if (errEst) {
    return wmsErrorResponse({
      source: "wms.separacao.produto-localizacoes",
      error: errEst,
      requestPath: REQ_PATH,
      requestMethod: "GET",
    });
  }
  const saldoPorLoc = new Map<string, { saldo: number; disponivel: number }>();
  for (const e of estoque ?? []) {
    const locId = e.localizacao_id as string | null;
    if (!locId) continue;
    saldoPorLoc.set(locId, {
      saldo: Number(e.saldo ?? 0),
      disponivel: Number(e.disponivel ?? 0),
    });
  }

  // União: locais com histórico ∪ locais com saldo (estoque ⊆ movs, mas garante).
  const locIds = new Set<string>([...porLoc.keys(), ...saldoPorLoc.keys()]);
  if (locIds.size === 0) return NextResponse.json({ rows: [] });

  // codigo/tipo dos locais.
  const { data: locs, error: errLoc } = await sb
    .from("siso_localizacoes")
    .select("id, codigo, tipo")
    .in("id", Array.from(locIds));
  if (errLoc) {
    return wmsErrorResponse({
      source: "wms.separacao.produto-localizacoes",
      error: errLoc,
      requestPath: REQ_PATH,
      requestMethod: "GET",
    });
  }
  const metaPorLoc = new Map<string, { codigo: string; tipo: string }>();
  for (const l of locs ?? []) {
    metaPorLoc.set(l.id as string, {
      codigo: (l.codigo as string) ?? "—",
      tipo: (l.tipo as string) ?? "",
    });
  }

  const rows = Array.from(locIds).map((locId) => {
    const meta = metaPorLoc.get(locId);
    const saldo = saldoPorLoc.get(locId);
    const hist = porLoc.get(locId);
    return {
      localizacao_id: locId,
      codigo: meta?.codigo ?? "—",
      tipo: meta?.tipo ?? "",
      saldo: saldo?.saldo ?? 0,
      disponivel: saldo?.disponivel ?? 0,
      ultima_movimentacao: hist?.ultima_movimentacao ?? null,
      movs: hist?.movs ?? 0,
    };
  });

  // Saldo>0 primeiro (desc); resto por última mov desc.
  rows.sort((a, b) => {
    if (a.saldo > 0 !== b.saldo > 0) return a.saldo > 0 ? -1 : 1;
    if (a.saldo !== b.saldo) return b.saldo - a.saldo;
    const ta = a.ultima_movimentacao ? Date.parse(a.ultima_movimentacao) : 0;
    const tb = b.ultima_movimentacao ? Date.parse(b.ultima_movimentacao) : 0;
    return tb - ta;
  });

  return NextResponse.json({ rows });
}

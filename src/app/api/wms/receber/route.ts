import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { receberEstoque } from "@/lib/wms/movimentacoes";
import {
  sugerirLocalizacaoPutaway,
  listarLocaisExistentesProduto,
} from "@/lib/wms/putaway";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * 3D body shape:
 *   - galpao_id (required)
 *   - itens[] (required) — cada item: { produto_id, qty, custo_unitario, localizacao_destino_id? }
 *   - empresa_compradora_id (required quando origem='nf_compra')
 *   - fornecedor_id (required)
 *   - custo_unitario (required no item ou no body; valida >= 0)
 *   - nota_fiscal_id (optional uuid)
 *   - chave_acesso_nf (optional text)
 *   - motivo (optional)
 *   - origem_tipo (default 'nf_compra')
 *   - data_recebimento (optional ISO, não-futuro)
 *   - entrada_direta (optional bool; pula dock RECEBIMENTO)
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  const origemTipo = body.origem_tipo ?? "nf_compra";

  if (!body.galpao_id || !Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "galpao_id e itens[] obrigatórios" },
      { status: 400 },
    );
  }

  if (!body.fornecedor_id) {
    return NextResponse.json(
      { error: "fornecedor_id é obrigatório" },
      { status: 400 },
    );
  }

  if (origemTipo === "nf_compra" && !body.empresa_compradora_id) {
    return NextResponse.json(
      { error: "empresa_compradora_id é obrigatório para origem nf_compra" },
      { status: 400 },
    );
  }

  // custo_unitario: precisa estar presente no body OU em todos os itens
  const custoBody =
    body.custo_unitario !== undefined && body.custo_unitario !== null
      ? Number(body.custo_unitario)
      : null;
  if (custoBody !== null && (!Number.isFinite(custoBody) || custoBody <= 0)) {
    return NextResponse.json(
      { error: "custo_unitario inválido (deve ser numérico > 0)" },
      { status: 400 },
    );
  }
  for (let i = 0; i < body.itens.length; i++) {
    const it = body.itens[i];
    if (!it.produto_id || typeof it.qty !== "number" || it.qty <= 0) {
      return NextResponse.json(
        { error: `item ${i + 1}: produto_id e qty>0 obrigatórios` },
        { status: 400 },
      );
    }
    const custoItem =
      it.custo_unitario !== undefined && it.custo_unitario !== null
        ? Number(it.custo_unitario)
        : custoBody;
    if (custoItem === null) {
      return NextResponse.json(
        { error: `item ${i + 1}: custo_unitario obrigatório` },
        { status: 400 },
      );
    }
    if (!Number.isFinite(custoItem) || custoItem <= 0) {
      return NextResponse.json(
        { error: `item ${i + 1}: custo_unitario deve ser > 0` },
        { status: 400 },
      );
    }
    // normaliza no item pra passar pro lib
    it.custo_unitario = custoItem;
  }

  // Valida data_recebimento se vier: precisa ser ISO parseável e não pode
  // ser futuro (no max o relógio atual do servidor com 5min de tolerância
  // pra clock skew entre cliente/servidor).
  if (body.data_recebimento !== undefined && body.data_recebimento !== null) {
    const ts = new Date(body.data_recebimento);
    if (isNaN(ts.getTime())) {
      return NextResponse.json(
        { error: "data_recebimento inválida" },
        { status: 400 },
      );
    }
    if (ts.getTime() > Date.now() + 5 * 60 * 1000) {
      return NextResponse.json(
        { error: "data_recebimento não pode ser no futuro" },
        { status: 400 },
      );
    }
  }
  try {
    const result = await receberEstoque({
      galpao_id: body.galpao_id,
      itens: body.itens,
      empresa_compradora_id: body.empresa_compradora_id ?? null,
      fornecedor_id: body.fornecedor_id ?? null,
      nf_referencia: body.nf_referencia,
      nota_fiscal_id: body.nota_fiscal_id ?? null,
      chave_acesso_nf: body.chave_acesso_nf ?? null,
      motivo: body.motivo ?? null,
      data_recebimento: body.data_recebimento,
      origem_tipo: origemTipo,
      observacoes: body.observacoes,
      entrada_direta: body.entrada_direta === true,
      usuario_id: auth.user.id,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.receber",
      error: e,
      requestPath: "/api/wms/receber",
      requestMethod: "POST",
      metadata: {
        empresa_compradora_id: body.empresa_compradora_id,
        fornecedor_id: body.fornecedor_id,
        galpao_id: body.galpao_id,
        nf_referencia: body.nf_referencia,
        data_recebimento: body.data_recebimento,
        n_itens: Array.isArray(body.itens) ? body.itens.length : 0,
      },
    });
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const sp = req.nextUrl.searchParams;
  const produto_id = sp.get("produto_id");
  const galpao_id = sp.get("galpao_id");
  if (!produto_id || !galpao_id) {
    return NextResponse.json(
      { error: "produto_id, galpao_id obrigatórios" },
      { status: 400 },
    );
  }
  try {
    const sb = createServiceClient();
    const [sugestao, locaisExistentes] = await Promise.all([
      sugerirLocalizacaoPutaway(sb as never, {
        produto_id,
        galpao_id,
      }),
      listarLocaisExistentesProduto(sb as never, {
        produto_id,
        galpao_id,
      }),
    ]);
    return NextResponse.json({
      localizacao_id: sugestao?.localizacao_id ?? null,
      codigo: sugestao?.codigo ?? null,
      razao: sugestao?.razao ?? null,
      locaisExistentes,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.receber.putaway",
      error: e,
      requestPath: "/api/wms/receber",
      requestMethod: "GET",
      metadata: { produto_id, galpao_id },
    });
  }
}

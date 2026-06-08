import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import {
  criarCompraManual,
  listarComprasManuais,
} from "@/lib/wms/compras-manuais";

export async function GET(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.ver")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const status = req.nextUrl.searchParams.get("status");
  const filtro =
    status === "recebido" || status === "cancelado" ? status : "pendentes";
  try {
    return NextResponse.json({ rows: await listarComprasManuais(filtro) });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.listar",
      error: e,
      requestPath: "/api/wms/compras-manuais",
      requestMethod: "GET",
    });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "compras.executar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json();
  if (!body.fornecedor_id || !body.empresa_compradora_id || !body.galpao_id) {
    return NextResponse.json(
      { error: "fornecedor_id, empresa_compradora_id e galpao_id são obrigatórios" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.itens) || body.itens.length === 0) {
    return NextResponse.json(
      { error: "envie { itens: [{ produto_id, qty_comprada }] }" },
      { status: 400 },
    );
  }
  try {
    const r = await criarCompraManual({
      fornecedor_id: body.fornecedor_id,
      empresa_compradora_id: body.empresa_compradora_id,
      galpao_id: body.galpao_id,
      observacao: body.observacao ?? null,
      criado_por: session.id,
      itens: body.itens.map((it: { produto_id: string; qty_comprada: number; custo_unitario?: number }) => ({
        produto_id: it.produto_id,
        qty_comprada: Number(it.qty_comprada),
        custo_unitario: it.custo_unitario != null ? Number(it.custo_unitario) : null,
      })),
    });
    return NextResponse.json({ ok: true, ...r }, { status: 201 });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.compras-manuais.criar",
      error: e,
      status: 400,
      requestPath: "/api/wms/compras-manuais",
      requestMethod: "POST",
    });
  }
}

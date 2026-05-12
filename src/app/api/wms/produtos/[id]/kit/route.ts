import { NextRequest, NextResponse } from "next/server";
import {
  listarComposicaoKit,
  listarEstoqueComponentes,
  upsertComponente,
  removerComponente,
  calcularDisponivel,
} from "@/lib/wms/kits";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** GET — composição do kit + disponível derivado + gargalo. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const empresa = req.nextUrl.searchParams.get("empresa_dona_id") ?? undefined;
  const galpao = req.nextUrl.searchParams.get("galpao_id") ?? undefined;

  try {
    const [composicao, disponivel] = await Promise.all([
      listarComposicaoKit(id),
      calcularDisponivel(id, {
        empresa_dona_id: empresa,
        galpao_id: galpao,
      }),
    ]);
    const estoquePorComponente = await listarEstoqueComponentes(
      composicao.map((c) => c.componente_produto_id),
      { empresa_dona_id: empresa, galpao_id: galpao },
    );
    const composicaoComEstoque = composicao.map((c) => ({
      ...c,
      estoque: estoquePorComponente.get(c.componente_produto_id) ?? {
        disponivel_total: 0,
        saldo_total: 0,
        reservado_total: 0,
        posicoes: [],
      },
    }));
    return NextResponse.json({
      composicao: composicaoComEstoque,
      disponivel,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.kit.get",
      error: e,
      requestPath: `/api/wms/produtos/${id}/kit`,
      requestMethod: "GET",
      metadata: { kit_id: id },
    });
  }
}

/** POST — adiciona/atualiza um componente no kit. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = (await req.json()) as {
    componente_produto_id?: string;
    quantidade?: number;
  };

  if (!body.componente_produto_id || typeof body.quantidade !== "number") {
    return NextResponse.json(
      { error: "componente_produto_id e quantidade obrigatórios" },
      { status: 400 },
    );
  }

  try {
    await upsertComponente({
      kit_produto_id: id,
      componente_produto_id: body.componente_produto_id,
      quantidade: body.quantidade,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.kit.upsert",
      error: e,
      requestPath: `/api/wms/produtos/${id}/kit`,
      requestMethod: "POST",
      metadata: {
        kit_id: id,
        componente_produto_id: body.componente_produto_id,
      },
    });
  }
}

/** DELETE — remove um componente do kit (query: componente_id). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const componenteId = req.nextUrl.searchParams.get("componente_id");
  if (!componenteId) {
    return NextResponse.json(
      { error: "componente_id obrigatório" },
      { status: 400 },
    );
  }

  try {
    await removerComponente({
      kit_produto_id: id,
      componente_produto_id: componenteId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.kit.remove",
      error: e,
      requestPath: `/api/wms/produtos/${id}/kit`,
      requestMethod: "DELETE",
      metadata: { kit_id: id, componente_produto_id: componenteId },
    });
  }
}

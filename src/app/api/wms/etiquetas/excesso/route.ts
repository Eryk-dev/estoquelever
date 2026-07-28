import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";
import { imprimirEtiquetaExcesso } from "@/lib/wms/etiqueta-produto-service";

/**
 * POST /api/wms/etiquetas/excesso
 *
 * Imprime N vias da etiqueta de excesso 10×15 (paisagem) com a quantidade
 * estampada — pra marcar caixa de overstock. Sai na impressora de EXCESSO
 * do galpão, que cai pra de envio quando não configurada (é a que tem mídia
 * 10×15), não na de produto.
 *
 * Body: `{ produto_id, galpao_id, qty, copias?, localizacao_id? }`
 *   - qty: inteiro >= 1, é o número impresso na etiqueta (não nº de vias)
 *   - copias: inteiro 1..50, nº de vias físicas (default 1)
 *   - localizacao_id opcional — sem ela a etiqueta sai com "—"
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const produtoId = body?.produto_id;
  const galpaoId = body?.galpao_id;
  const qty = body?.qty;
  const copias = body?.copias ?? 1;
  const localizacaoId = body?.localizacao_id;

  if (typeof produtoId !== "string" || typeof galpaoId !== "string") {
    return NextResponse.json(
      { error: "produto_id e galpao_id (strings) são obrigatórios" },
      { status: 400 },
    );
  }
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 99999) {
    return NextResponse.json(
      { error: "qty deve ser inteiro entre 1 e 99999" },
      { status: 400 },
    );
  }
  if (typeof copias !== "number" || !Number.isInteger(copias) || copias < 1 || copias > 50) {
    return NextResponse.json(
      { error: "copias deve ser inteiro entre 1 e 50" },
      { status: 400 },
    );
  }

  try {
    const sb = createServiceClient();
    const [produtoRes, galpaoRes, locRes] = await Promise.all([
      sb.from("siso_produtos").select("id, sku, descricao").eq("id", produtoId).single(),
      sb.from("siso_galpoes").select("id, nome").eq("id", galpaoId).single(),
      typeof localizacaoId === "string"
        ? sb.from("siso_localizacoes").select("codigo").eq("id", localizacaoId).single()
        : Promise.resolve({ data: null }),
    ]);

    const produto = produtoRes.data;
    const galpao = galpaoRes.data;
    if (!produto) {
      return NextResponse.json({ error: "produto não encontrado" }, { status: 404 });
    }
    if (!galpao) {
      return NextResponse.json({ error: "galpão não encontrado" }, { status: 404 });
    }

    const data = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date());

    const result = await imprimirEtiquetaExcesso({
      usuarioId: auth.user.id,
      galpaoId,
      titulo: `Etiqueta excesso ${produto.sku} (${qty} un${copias > 1 ? ` × ${copias} vias` : ""})`,
      copias,
      contextoRefId: produto.id,
      etiqueta: {
        sku: produto.sku,
        descricao: produto.descricao,
        qty,
        localizacao: (locRes.data as { codigo: string } | null)?.codigo ?? "—",
        galpao: galpao.nome,
        data,
      },
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      totalEtiquetas: result.totalEtiquetas,
      printerNome: result.printerNome,
      fallbackEnvelope: result.fallbackEnvelope,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.etiquetas.excesso",
      error: e,
      requestPath: "/api/wms/etiquetas/excesso",
      requestMethod: "POST",
    });
  }
}

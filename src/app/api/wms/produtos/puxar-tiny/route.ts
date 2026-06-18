import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { puxarProdutoDoTinyPorSku } from "@/lib/wms/sync-tiny";

// Busca o SKU em N contas Tiny — pode passar do timeout default em backlog.
export const maxDuration = 60;

/**
 * POST /api/wms/produtos/puxar-tiny  { sku }
 *
 * Consulta + cadastro automático: busca o SKU em todas as contas Tiny
 * conectadas e cadastra/atualiza o produto no catálogo (siso_produtos) +
 * pontes tiny→wms. Usado pelo botão "Puxar do Tiny" da página de produtos.
 *
 * Auth: requireWarehouseAccess (mesmo do sync por-linha).
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  let body: { sku?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body inválido" }, { status: 400 });
  }
  const sku = (body.sku ?? "").trim();
  if (!sku) {
    return NextResponse.json({ error: "sku obrigatório" }, { status: 400 });
  }

  try {
    const r = await puxarProdutoDoTinyPorSku(sku);
    if (!r.encontrado) {
      return NextResponse.json(
        {
          error: `SKU "${sku}" não encontrado em nenhuma conta Tiny conectada${
            r.contasComErro ? ` (${r.contasComErro} conta(s) com erro de conexão)` : ""
          }`,
        },
        { status: 404 },
      );
    }
    return NextResponse.json(r);
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.produtos.puxar-tiny",
      error: e,
      category: "external_api",
      requestPath: "/api/wms/produtos/puxar-tiny",
      requestMethod: "POST",
      metadata: { sku },
    });
  }
}

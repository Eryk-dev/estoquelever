import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { mandarItensParaCompras } from "@/lib/wms/mandar-compras";

interface Body {
  pedido_ids?: string[];
  item_ids?: string[];
}

/**
 * POST /api/wms/separacao/mandar-pra-compras
 *
 * Endpoint manual — preservado pra eventual reaproveitamento (supervisor,
 * admin tool, etc). No fluxo padrão do operador, `/api/wms/separacao/parcial`
 * já transita automaticamente quando o cascade esgota — sem modal.
 *
 * Body: { pedido_ids: string[], item_ids: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  if (!userCan(session, "separacao.executar")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedido_ids, item_ids } = body;
  if (
    !Array.isArray(pedido_ids) ||
    !Array.isArray(item_ids) ||
    item_ids.length === 0
  ) {
    return NextResponse.json(
      { error: "pedido_ids e item_ids são obrigatórios" },
      { status: 400 },
    );
  }

  const result = await mandarItensParaCompras({
    supabase: createServiceClient(),
    pedido_ids,
    item_ids,
    usuario_id: session.id,
    usuario_nome: session.nome,
  });

  return NextResponse.json({ ok: true, ...result });
}

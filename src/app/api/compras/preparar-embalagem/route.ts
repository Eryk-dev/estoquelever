import { NextRequest, NextResponse } from "next/server";

import { prepararPedidosDasOcsParaEmbalagem } from "@/lib/compras-embalagem";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { hasComprasAccess } from "@/lib/compras-utils";

interface PrepararBody {
  ordem_compra_ids?: string[];
}

export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!hasComprasAccess(session.cargos)) return NextResponse.json({ error: "Acesso negado" }, { status: 403 });

  let body: PrepararBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { ordem_compra_ids } = body;
  const usuario_id = session.id;
  const usuario_nome = session.nome;

  if (!ordem_compra_ids || !Array.isArray(ordem_compra_ids) || ordem_compra_ids.length === 0) {
    return NextResponse.json(
      { error: "ordem_compra_ids deve ser um array com pelo menos uma OC" },
      { status: 400 },
    );
  }

  try {
    const result = await prepararPedidosDasOcsParaEmbalagem({
      ordemCompraIds: ordem_compra_ids,
      usuarioId: usuario_id ?? null,
      usuarioNome: usuario_nome ?? null,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro interno";

    logger.error("compras-preparar-embalagem", "Erro ao preparar pedidos para embalagem", {
      ordemCompraIds: ordem_compra_ids,
      error: message,
    });

    const status = message.includes("galpões diferentes") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

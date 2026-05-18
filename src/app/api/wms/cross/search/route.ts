import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { searchProdutos } from "@/lib/cross/catalogo-queries";
import type { TipoBusca } from "@/lib/cross/types";

export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const tipoParam = (searchParams.get("tipo") ?? "auto") as TipoBusca;

  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: "Parâmetro q obrigatório (mínimo 2 caracteres)" },
      { status: 400 },
    );
  }

  if (!["auto", "sku", "oem", "nome"].includes(tipoParam)) {
    return NextResponse.json(
      { error: "tipo deve ser: auto | sku | oem | nome" },
      { status: 400 },
    );
  }

  try {
    const resposta = await searchProdutos({ query, tipo: tipoParam });
    logger.info("cross-search", "Busca executada", {
      usuario: session.id,
      query,
      tipo: tipoParam,
      total: resposta.total,
    });

    // Telemetria fire-and-forget — registra a busca para análise posterior
    void (async () => {
      try {
        const sb = createServiceClient();
        await sb.from("siso_cross_logs").insert({
          query_tipo: tipoParam,
          query_texto: query,
          resultado_count: resposta.total,
          usuario_id: session.id,
        });
      } catch (err) {
        logger.warn("cross-search", "Falha ao logar busca (não crítico)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return NextResponse.json(resposta);
  } catch (err) {
    logger.error("cross-search", "Erro na busca", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import {
  getAnunciosPorSku,
  normalizarSkuAnuncio,
} from "@/lib/ml-anuncios";
import {
  LIMITACAO_BUSCA_DIRETA_ML,
  type ResultadoVerificacaoDiretaMl,
} from "@/lib/ml-anuncios-status";
import { isMlDisabled } from "@/lib/ml-stub";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (!auth.ok) return auth.response;

  let body: { sku?: unknown };
  try {
    body = (await request.json()) as { sku?: unknown };
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const sku =
    typeof body.sku === "string" ? normalizarSkuAnuncio(body.sku) : "";
  if (!sku || sku.length > 120) {
    return NextResponse.json({ error: "SKU inválido" }, { status: 400 });
  }
  if (isMlDisabled()) {
    return NextResponse.json(
      { error: "Integração Mercado Livre desabilitada" },
      { status: 503 },
    );
  }

  try {
    const resultado = await getAnunciosPorSku(sku, {
      forceRefresh: true,
      strictSearch: true,
    });
    const ativos = resultado.anuncios.filter(
      (anuncio) => anuncio.status === "active",
    );

    // Encontrar um anúncio ativo em qualquer conta já é conclusivo, mesmo se
    // outra conta estiver indisponível.
    if (ativos.length > 0) {
      const response = {
        sku,
        situacao: "com_anuncio",
        conclusivo: true,
        anuncios_ativos: ativos.length,
        contas_consultadas: resultado.contas_consultadas,
        contas_com_erro: resultado.contas_com_erro,
        limitacao: null,
      } satisfies ResultadoVerificacaoDiretaMl;
      return NextResponse.json(response);
    }

    if (resultado.contas_consultadas === 0) {
      return NextResponse.json(
        { error: "Nenhuma conta Mercado Livre ativa para consultar" },
        { status: 409 },
      );
    }
    if (resultado.contas_com_erro.length > 0) {
      return NextResponse.json(
        {
          error:
            "Não foi possível concluir a busca direta em todas as contas",
          contas_com_erro: resultado.contas_com_erro,
        },
        { status: 502 },
      );
    }

    // O search do ML não encontra de forma exaustiva SKUs que vivem apenas
    // dentro de variations[]. Vazio aqui é uma pista útil, não prova ausência.
    const response = {
      sku,
      situacao: "inconclusivo_busca_direta",
      conclusivo: false,
      anuncios_ativos: 0,
      contas_consultadas: resultado.contas_consultadas,
      contas_com_erro: [] as [],
      limitacao: LIMITACAO_BUSCA_DIRETA_ML,
    } satisfies ResultadoVerificacaoDiretaMl;
    return NextResponse.json(response);
  } catch (error) {
    return wmsErrorResponse({
      source: "wms.estoque.sem-anuncio.verificar",
      error,
      requestPath: "/api/wms/estoque/sem-anuncio/verificar",
      requestMethod: "POST",
      metadata: { sku },
    });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { obterPendencia } from "@/lib/wms/guarda";
import { imprimirEtiquetasProduto } from "@/lib/wms/etiqueta-produto-service";
import type { EtiquetaProdutoInput } from "@/lib/wms/zpl-produto";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * POST /api/wms/guarda/imprimir-lote
 *
 * Body: { pendencia_ids: string[] }
 *
 * Imprime o maço inteiro de etiquetas pra uma lista de pendências. Pendências
 * canceladas/totalmente guardadas são puladas (com warning em `ignorados`).
 *
 * Mistura de galpões: AGRUPA por galpao_id e dispara 1 print job por galpão
 * (impressora pode ser diferente). Falha em algum galpão não aborta os outros
 * — retorna todos os resultados em `jobs` + erros em `erros`.
 *
 * Localização na etiqueta = loc destino decidida no recebimento, ou (se NULL)
 * candidato com saldo>0 do mesmo SKU, ou "—" como último recurso.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const ids: unknown = body?.pendencia_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "pendencia_ids (array não vazio) é obrigatório" },
      { status: 400 },
    );
  }
  const pendenciaIds = ids.filter((x): x is string => typeof x === "string");
  if (pendenciaIds.length === 0) {
    return NextResponse.json(
      { error: "pendencia_ids deve conter strings" },
      { status: 400 },
    );
  }

  try {
    const sb = createServiceClient();
    type Linha = { etiqueta: EtiquetaProdutoInput; qty: number };
    const porGalpao = new Map<string, Linha[]>();
    const ignorados: string[] = [];

    for (const id of pendenciaIds) {
      const pend = await obterPendencia(id);
      if (!pend || pend.status === "cancelada" || pend.qty_pendente <= 0) {
        ignorados.push(id);
        continue;
      }
      if (!pend.produto) {
        ignorados.push(id);
        continue;
      }

      let localizacao = pend.localizacao_destino?.codigo ?? null;
      if (!localizacao) {
        const { data: existentes } = await sb
          .from("siso_estoque")
          .select("localizacao:siso_localizacoes(codigo)")
          .match({
            produto_id: pend.produto_id,
            empresa_dona_id: pend.empresa_dona_id,
            galpao_id: pend.galpao_id,
          })
          .gt("saldo", 0)
          .neq("localizacao_id", pend.localizacao_origem_id)
          .order("saldo", { ascending: false })
          .limit(1);
        type Lin = { localizacao?: { codigo?: string } };
        const candidato = ((existentes ?? []) as Lin[])[0];
        localizacao = candidato?.localizacao?.codigo ?? "—";
      }

      const linha: Linha = {
        etiqueta: {
          sku: pend.produto.sku,
          descricao: pend.produto.descricao,
          localizacao,
        },
        qty: pend.qty_pendente,
      };
      const arr = porGalpao.get(pend.galpao_id) ?? [];
      arr.push(linha);
      porGalpao.set(pend.galpao_id, arr);
    }

    if (porGalpao.size === 0) {
      return NextResponse.json(
        { error: "nenhuma etiqueta pra imprimir", ignorados },
        { status: 400 },
      );
    }

    // Dispara um print job por galpão. Falha em um não aborta os outros.
    const jobs: Array<{
      galpaoId: string;
      jobId?: number;
      totalEtiquetas?: number;
      totalFolhas?: number;
      fallbackEnvelope?: boolean;
    }> = [];
    const erros: Array<{ galpaoId: string; error: string }> = [];
    let totalEtiquetas = 0;
    let totalFolhas = 0;
    let algumFallback = false;

    for (const [galpaoId, linhas] of porGalpao.entries()) {
      const result = await imprimirEtiquetasProduto({
        usuarioId: auth.user.id,
        galpaoId,
        titulo: `Etiquetas recebimento (${linhas.length} linhas)`,
        linhas,
      });
      if (!result.ok) {
        erros.push({ galpaoId, error: result.error ?? "falha ao imprimir" });
      } else {
        jobs.push({
          galpaoId,
          jobId: result.jobId,
          totalEtiquetas: result.totalEtiquetas,
          totalFolhas: result.totalFolhas,
          fallbackEnvelope: result.fallbackEnvelope,
        });
        totalEtiquetas += result.totalEtiquetas ?? 0;
        totalFolhas += result.totalFolhas ?? 0;
        if (result.fallbackEnvelope) algumFallback = true;
      }
    }

    if (jobs.length === 0 && erros.length > 0) {
      return NextResponse.json(
        { error: erros[0].error, erros, ignorados },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      ignorados,
      jobs,
      erros,
      totalEtiquetas,
      totalFolhas,
      fallbackEnvelope: algumFallback,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.guarda.imprimir-lote",
      error: e,
      requestPath: "/api/wms/guarda/imprimir-lote",
      requestMethod: "POST",
    });
  }
}

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
 * Aceita 2 modos de entrada no body:
 *
 *   1) `{ pendencia_ids: string[] }` (modo guarda)
 *      Imprime etiquetas a partir de pendências existentes em
 *      `siso_wms_pendencias_guarda`. Pendências canceladas/totalmente
 *      guardadas são puladas (com warning em `ignorados`).
 *
 *   2) `{ linhas: [{ produto_id, galpao_id, qty, localizacao_id? }] }`
 *      (modo entrada direta — recebimento que pulou a guarda)
 *      Imprime direto a partir dos itens recém-recebidos. Resolve
 *      sku/descricao/loc num único SELECT join. `localizacao_id` é opcional
 *      — se omitido, mostra "—" na etiqueta.
 *
 * Em ambos os modos: AGRUPA por galpao_id e dispara 1 print job por galpão
 * (impressora pode ser diferente). Falha em algum galpão não aborta os
 * outros — retorna resultados em `jobs` + erros em `erros`.
 *
 * No modo pendência, quando a pendência não tem loc destino decidida,
 * cai num candidato com saldo>0 do mesmo SKU como hint pra etiqueta.
 */

interface LinhaInput {
  produto_id: string;
  galpao_id: string;
  qty: number;
  localizacao_id?: string;
}

type Linha = { etiqueta: EtiquetaProdutoInput; qty: number };

export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const modoPendencias = Array.isArray(body?.pendencia_ids);
  const modoLinhas = Array.isArray(body?.linhas);

  if (!modoPendencias && !modoLinhas) {
    return NextResponse.json(
      {
        error:
          "informe `pendencia_ids: string[]` (modo guarda) ou `linhas: [{produto_id, galpao_id, qty}]` (modo entrada direta)",
      },
      { status: 400 },
    );
  }
  if (modoPendencias && modoLinhas) {
    return NextResponse.json(
      { error: "use apenas um modo: pendencia_ids OU linhas" },
      { status: 400 },
    );
  }

  try {
    const sb = createServiceClient();
    const porGalpao = new Map<string, Linha[]>();
    const ignorados: string[] = [];

    if (modoPendencias) {
      const ids = (body.pendencia_ids as unknown[]).filter(
        (x): x is string => typeof x === "string",
      );
      if (ids.length === 0) {
        return NextResponse.json(
          { error: "pendencia_ids deve conter strings" },
          { status: 400 },
        );
      }
      for (const id of ids) {
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
    } else {
      // Modo linhas (entrada direta)
      const linhasRaw = body.linhas as unknown[];
      const linhasIn: LinhaInput[] = [];
      for (const l of linhasRaw) {
        if (
          !l ||
          typeof l !== "object" ||
          typeof (l as LinhaInput).produto_id !== "string" ||
          typeof (l as LinhaInput).galpao_id !== "string" ||
          typeof (l as LinhaInput).qty !== "number"
        ) {
          return NextResponse.json(
            {
              error:
                "cada linha precisa de produto_id (string), galpao_id (string), qty (number > 0)",
            },
            { status: 400 },
          );
        }
        const li = l as LinhaInput;
        if (li.qty <= 0) {
          return NextResponse.json(
            { error: "qty deve ser > 0 em todas as linhas" },
            { status: 400 },
          );
        }
        linhasIn.push({
          produto_id: li.produto_id,
          galpao_id: li.galpao_id,
          qty: li.qty,
          localizacao_id:
            typeof li.localizacao_id === "string" ? li.localizacao_id : undefined,
        });
      }
      if (linhasIn.length === 0) {
        return NextResponse.json(
          { error: "linhas vazio" },
          { status: 400 },
        );
      }

      // Resolve SKU/descricao/loc em 2 queries (1 produtos + 1 locs).
      const produtoIds = Array.from(new Set(linhasIn.map((l) => l.produto_id)));
      const locIds = Array.from(
        new Set(
          linhasIn
            .map((l) => l.localizacao_id)
            .filter((x): x is string => !!x),
        ),
      );

      const { data: produtos } = await sb
        .from("siso_produtos")
        .select("id, sku, descricao")
        .in("id", produtoIds);
      const produtoMap = new Map<string, { sku: string; descricao: string }>();
      (produtos ?? []).forEach((p) =>
        produtoMap.set(p.id, { sku: p.sku, descricao: p.descricao }),
      );

      const locMap = new Map<string, string>();
      if (locIds.length > 0) {
        const { data: locs } = await sb
          .from("siso_localizacoes")
          .select("id, codigo")
          .in("id", locIds);
        (locs ?? []).forEach((l) => locMap.set(l.id, l.codigo));
      }

      for (const li of linhasIn) {
        const prod = produtoMap.get(li.produto_id);
        if (!prod) {
          ignorados.push(li.produto_id);
          continue;
        }
        const localizacao = li.localizacao_id
          ? (locMap.get(li.localizacao_id) ?? "—")
          : "—";
        const linha: Linha = {
          etiqueta: {
            sku: prod.sku,
            descricao: prod.descricao,
            localizacao,
          },
          qty: li.qty,
        };
        const arr = porGalpao.get(li.galpao_id) ?? [];
        arr.push(linha);
        porGalpao.set(li.galpao_id, arr);
      }
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

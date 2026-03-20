import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getCompraQuantidadeSolicitada } from "@/lib/compras-utils";
import type { ConferenciaItem } from "@/types";

const ALLOWED_CARGOS = ["admin", "comprador"];

interface RawConferenciaItem {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  compra_quantidade_solicitada: number;
  compra_status: string | null;
  compra_quantidade_recebida: number;
  imagem_url: string | null;
  produto_id_tiny: number | null;
  pedido_id: string;
  siso_pedidos: { numero: string } | null;
}

/**
 * GET /api/compras/conferencia/[ordemCompraId]
 *
 * Returns OC info + items for the receiving/checking screen.
 * Items with compra_status='recebido' are excluded (fully received).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ordemCompraId: string }> },
) {
  const { ordemCompraId } = await params;
  const { searchParams } = new URL(request.url);

  // Auth check
  const cargo = searchParams.get("cargo");
  if (cargo && !ALLOWED_CARGOS.includes(cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    // Fetch the OC (with galpão info)
    const { data: oc, error: ocError } = await supabase
      .from("siso_ordens_compra")
      .select(
        "id, fornecedor, empresa_id, galpao_id, status, observacao, comprado_por, comprado_em, created_at, siso_usuarios:comprado_por(nome), siso_galpoes:galpao_id(nome)",
      )
      .eq("id", ordemCompraId)
      .single();

    if (ocError || !oc) {
      if (ocError?.code === "PGRST116") {
        return NextResponse.json(
          { error: "Ordem de compra nao encontrada" },
          { status: 404 },
        );
      }
      throw new Error(`Erro ao buscar OC: ${ocError?.message ?? "not found"}`);
    }

    // Fetch items for this OC that are not fully received
    const { data: items, error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, sku, descricao, quantidade_pedida, compra_quantidade_solicitada, compra_status, compra_quantidade_recebida, imagem_url, produto_id_tiny, pedido_id, siso_pedidos(numero)",
      )
      .eq("ordem_compra_id", ordemCompraId)
      .eq("compra_status", "comprado");

    if (itemsError) {
      throw new Error(`Erro ao buscar itens: ${itemsError.message}`);
    }

    const rawItems = (items ?? []) as unknown as RawConferenciaItem[];

    const conferenciaItens: ConferenciaItem[] = rawItems.map((item) => {
      const quantidadeEsperada = getCompraQuantidadeSolicitada(item);
      return {
        item_id: String(item.id),
        sku: item.sku,
        descricao: item.descricao,
        imagem: item.imagem_url ?? null,
        quantidade_esperada: quantidadeEsperada,
        quantidade_ja_recebida: item.compra_quantidade_recebida,
        quantidade_restante: Math.max(
          quantidadeEsperada - item.compra_quantidade_recebida,
          0,
        ),
        produto_id_tiny: item.produto_id_tiny,
        pedidos: [
          {
            pedido_id: item.pedido_id,
            numero_pedido: item.siso_pedidos?.numero ?? "?",
            quantidade: quantidadeEsperada,
          },
        ],
      };
    });

    const ocTyped = oc as unknown as {
      id: string;
      fornecedor: string;
      empresa_id: string | null;
      galpao_id: string | null;
      status: string;
      observacao: string | null;
      comprado_por: string | null;
      comprado_em: string | null;
      created_at: string;
      siso_usuarios: { nome: string } | null;
      siso_galpoes: { nome: string } | null;
    };

    return NextResponse.json({
      ordem_compra: {
        id: ocTyped.id,
        fornecedor: ocTyped.fornecedor,
        galpao_id: ocTyped.galpao_id,
        galpao_nome: ocTyped.siso_galpoes?.nome ?? null,
        status: ocTyped.status,
        observacao: ocTyped.observacao,
        comprado_por_nome: ocTyped.siso_usuarios?.nome ?? null,
        comprado_em: ocTyped.comprado_em,
        created_at: ocTyped.created_at,
      },
      itens: conferenciaItens,
    });
  } catch (err) {
    logger.error("compras-conferencia", "Erro ao buscar conferencia", {
      error: err instanceof Error ? err.message : String(err),
      ordemCompraId,
    });
    return NextResponse.json(
      { error: "Erro interno ao buscar conferencia" },
      { status: 500 },
    );
  }
}

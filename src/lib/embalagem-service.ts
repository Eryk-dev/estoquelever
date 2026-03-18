import { buscarEImprimirEtiqueta, imprimirEtiquetaDireta } from "@/lib/etiqueta-service";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";
import { createServiceClient } from "@/lib/supabase-server";
import type { BipEmbalagemResult } from "@/types";

interface EmbalagemRpcRow {
  pedido_id: string;
  produto_id: string | number;
  quantidade_bipada: number | string | null;
  bipado_completo: boolean | null;
  pedido_completo: boolean | null;
  etiqueta_empresa_origem_id?: string | null;
  etiqueta_agrupamento_id?: string | null;
  etiqueta_zpl?: string | null;
  etiqueta_url?: string | null;
  etiqueta_galpao_id?: string | null;
  etiqueta_operador_id?: string | null;
  etiqueta_numero?: string | null;
}

export interface ProcessarEmbalagemParams {
  pedidoItemId?: string;
  sku?: string;
  galpaoId?: string;
  pedidoIds?: string[];
  quantidade: number;
  source: string;
}

export interface ProcessarEmbalagemResponse {
  status: number;
  body: {
    error?: string;
    status_atual?: string;
    pedido_id?: string;
    produto_id?: string;
    quantidade_bipada?: number;
    bipado_completo?: boolean;
    pedido_completo?: boolean;
    etiqueta_status?: string;
    etiqueta_erro?: string | null;
  };
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toResult(row: EmbalagemRpcRow): BipEmbalagemResult {
  return {
    pedido_id: row.pedido_id,
    produto_id: String(row.produto_id),
    quantidade_bipada: toNumber(row.quantidade_bipada),
    bipado_completo: !!row.bipado_completo,
    pedido_completo: !!row.pedido_completo,
  };
}

async function processarEtiqueta(
  row: EmbalagemRpcRow,
  result: BipEmbalagemResult,
  params: ProcessarEmbalagemParams,
) {
  registrarEvento({
    pedidoId: result.pedido_id,
    evento: "embalagem_concluida",
    detalhes: params.sku
      ? {
          sku: params.sku,
          galpao_id: params.galpaoId,
        }
      : undefined,
  }).catch(() => {});

  const etiqueta = row.etiqueta_empresa_origem_id && row.etiqueta_galpao_id
    ? await imprimirEtiquetaDireta({
        pedidoId: result.pedido_id,
        numero: row.etiqueta_numero ?? result.pedido_id,
        empresaOrigemId: row.etiqueta_empresa_origem_id,
        agrupamentoExpedicaoId: row.etiqueta_agrupamento_id ?? null,
        etiquetaZpl: row.etiqueta_zpl ?? null,
        etiquetaUrl: row.etiqueta_url ?? null,
        separacaoGalpaoId: row.etiqueta_galpao_id,
        separacaoOperadorId: row.etiqueta_operador_id ?? null,
      })
    : await buscarEImprimirEtiqueta(result.pedido_id);

  return {
    ...result,
    etiqueta_status: etiqueta.success ? "impresso" : "falhou",
    etiqueta_erro: etiqueta.error ?? null,
  };
}

export async function processarEmbalagem(
  params: ProcessarEmbalagemParams,
): Promise<ProcessarEmbalagemResponse> {
  const supabase = createServiceClient();

  if (params.pedidoItemId) {
    const { data: item, error: itemError } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id")
      .eq("id", params.pedidoItemId)
      .single();

    if (itemError || !item) {
      return {
        status: 404,
        body: { error: "Item nao encontrado" },
      };
    }

    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select("id, status_separacao")
      .eq("id", item.pedido_id)
      .single();

    if (pedidoError || !pedido) {
      return {
        status: 404,
        body: { error: "Pedido nao encontrado" },
      };
    }

    if (pedido.status_separacao !== "separado") {
      return {
        status: 400,
        body: {
          error: "Pedido deve estar com status 'separado' para embalagem",
          status_atual: pedido.status_separacao,
        },
      };
    }

    const { data, error } = await supabase.rpc(
      "siso_processar_item_embalagem",
      {
        p_pedido_item_id: params.pedidoItemId,
        p_delta: params.quantidade,
      },
    );

    if (error) {
      logger.error(params.source, "RPC error", {
        error: error.message,
        pedido_item_id: params.pedidoItemId,
        quantidade: params.quantidade,
      });
      return {
        status: 500,
        body: { error: error.message },
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return {
        status: 404,
        body: { error: "Item nao encontrado" },
      };
    }

    const result = toResult(row as EmbalagemRpcRow);
    logger.info(params.source, "Embalagem processada por item", {
      pedido_item_id: params.pedidoItemId,
      ...result,
    });

    if (!result.pedido_completo) {
      return { status: 200, body: result };
    }

    return {
      status: 200,
      body: await processarEtiqueta(row as EmbalagemRpcRow, result, params),
    };
  }

  const sku = params.sku?.trim();
  if (!sku || !params.galpaoId) {
    return {
      status: 400,
      body: { error: "'sku' e 'galpao_id' sao obrigatorios" },
    };
  }

  const { data, error } = await supabase.rpc(
    "siso_processar_bip_embalagem",
    {
      p_sku: sku,
      p_galpao_id: params.galpaoId,
      p_quantidade: params.quantidade,
      p_pedido_ids:
        params.pedidoIds && params.pedidoIds.length > 0
          ? params.pedidoIds
          : null,
    },
  );

  if (error) {
    logger.error(params.source, "RPC error", {
      error: error.message,
      sku,
      galpao_id: params.galpaoId,
      quantidade: params.quantidade,
    });
    return {
      status: 500,
      body: { error: error.message },
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      status: 404,
      body: { error: "Nenhum pedido com este SKU pendente de embalagem" },
    };
  }

  const result = toResult(row as EmbalagemRpcRow);
  logger.info(params.source, "Embalagem processada por SKU", {
    sku,
    galpao_id: params.galpaoId,
    pedido_ids: params.pedidoIds?.length ?? 0,
    ...result,
  });

  if (!result.pedido_completo) {
    return { status: 200, body: result };
  }

  return {
    status: 200,
    body: await processarEtiqueta(row as EmbalagemRpcRow, result, {
      ...params,
      sku,
    }),
  };
}

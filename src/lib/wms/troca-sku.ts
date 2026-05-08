import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import type { Quadrupla } from "./types";
import { logger } from "@/lib/logger";

export function validarTroca(input: {
  produto_original_id: string;
  produto_substituto_id: string;
}): void {
  if (input.produto_original_id === input.produto_substituto_id) {
    throw new Error("não é possível trocar pelo mesmo SKU");
  }
}

export interface TrocaSkuInput {
  pedido_id: string;
  quadrupla_original: Quadrupla;
  quadrupla_substituto: Quadrupla;
  qty: number;
  ttl_horas?: number;
  motivo?: string;
  usuario_id: string;
  validar_equivalencia_cross?: boolean;
}

export async function trocarSku(input: TrocaSkuInput): Promise<void> {
  validarTroca({
    produto_original_id: input.quadrupla_original.produto_id,
    produto_substituto_id: input.quadrupla_substituto.produto_id,
  });

  // Validação Cross (opcional, não bloqueante em v1)
  if (input.validar_equivalencia_cross !== false) {
    const sb = createServiceClient();
    const { data: produtos } = await sb
      .from("siso_produtos")
      .select("id, sku")
      .in("id", [
        input.quadrupla_original.produto_id,
        input.quadrupla_substituto.produto_id,
      ]);
    type ProdutoRow = { id: string; sku: string };
    const lista = (produtos ?? []) as ProdutoRow[];
    const skuOriginal = lista.find(
      (p) => p.id === input.quadrupla_original.produto_id,
    )?.sku;
    const skuSubstituto = lista.find(
      (p) => p.id === input.quadrupla_substituto.produto_id,
    )?.sku;
    if (skuOriginal && skuSubstituto) {
      try {
        const { data: equiv } = await sb
          .from("siso_produto_links")
          .select("id")
          .or(
            `and(sku_a.eq.${skuOriginal},sku_b.eq.${skuSubstituto}),and(sku_a.eq.${skuSubstituto},sku_b.eq.${skuOriginal})`,
          )
          .limit(1)
          .maybeSingle();
        if (!equiv) {
          logger.warn("wms.troca", "equivalência não registrada no Cross", {
            skuOriginal,
            skuSubstituto,
          });
        }
      } catch {
        // Tabela do Cross pode não estar presente em staging — ignora gracefully
      }
    }
  }

  const expira = new Date(
    Date.now() + (input.ttl_horas ?? 48) * 3600 * 1000,
  ).toISOString();

  await inserirMovimentacao({
    quadrupla: input.quadrupla_original,
    tipo: "L",
    qty: input.qty,
    origem_tipo: "troca_sku_out",
    origem_id: input.pedido_id,
    origem_detalhes: {
      motivo: input.motivo,
      substituto_produto_id: input.quadrupla_substituto.produto_id,
    },
    usuario_id: input.usuario_id,
    observacoes: `trocado por outro SKU, pedido ${input.pedido_id}`,
  });

  await inserirMovimentacao({
    quadrupla: input.quadrupla_substituto,
    tipo: "R",
    qty: input.qty,
    origem_tipo: "troca_sku_in",
    origem_id: input.pedido_id,
    expira_em: expira,
    origem_detalhes: {
      motivo: input.motivo,
      original_produto_id: input.quadrupla_original.produto_id,
    },
    usuario_id: input.usuario_id,
    observacoes: `substitui SKU original no pedido ${input.pedido_id}`,
  });
}

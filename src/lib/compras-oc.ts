import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface FindOrCreateOcArgs {
  fornecedor: string;
  /** Galpão de recebimento da OC. Quando nulo, cai pro (fornecedor, empresa). */
  galpaoId: string | null;
  empresaId: string | null;
  /** Nota de criação (ex.: origem). Default genérico. */
  observacao?: string;
}

/**
 * Find-or-create da OC ABERTA (`status='aguardando_compra'`) por (fornecedor,
 * galpão) — ou (fornecedor, empresa) quando não há galpão. **Race-safe:** se o
 * INSERT colide com o índice único parcial (23505), re-seleciona a OC vencedora
 * em vez de falhar.
 *
 * ÚNICO ponto de criação de OC — antes duplicado em `/api/wms/compras/comprar`
 * (`findOrCreateOC` local) e `/api/wms/separacao/validar-oc-item` (sem 23505).
 */
export async function findOrCreateOcAberta(
  sb: ServiceClient,
  args: FindOrCreateOcArgs,
): Promise<string | null> {
  const { fornecedor, galpaoId, empresaId, observacao } = args;
  if (!fornecedor) return null;

  const buscar = () => {
    let q = sb
      .from("siso_ordens_compra")
      .select("id")
      .eq("fornecedor", fornecedor)
      .eq("status", "aguardando_compra")
      .limit(1);
    if (galpaoId) q = q.eq("galpao_id", galpaoId);
    else if (empresaId) q = q.eq("empresa_id", empresaId);
    return q.maybeSingle();
  };

  const { data: existing } = await buscar();
  if (existing) return existing.id as string;

  const { data: created, error } = await sb
    .from("siso_ordens_compra")
    .insert({
      fornecedor,
      galpao_id: galpaoId,
      empresa_id: empresaId,
      status: "aguardando_compra",
      observacao: observacao ?? "Criada automaticamente",
    })
    .select("id")
    .single();

  if (error) {
    // Corrida: outra request criou a OC aberta entre o SELECT e o INSERT. Os
    // índices únicos parciais (galpão / empresa-com-galpão-null) disparam 23505;
    // re-seleciona e reusa a vencedora.
    if (error.code === "23505") {
      const { data: vencedora } = await buscar();
      if (vencedora) return vencedora.id as string;
    }
    logger.warn("compras-oc", "Erro criando OC", {
      error: error.message,
      fornecedor,
    });
    return null;
  }
  return created.id as string;
}

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PutawayContext {
  produto_id: string;
  empresa_id: string;
  galpao_id: string;
}

export interface PutawaySugestao {
  localizacao_id: string;
  codigo?: string;
  razao: string;
}

/**
 * Heurística:
 * 1. Se SKU já tem saldo nesse galpão+empresa, sugere essa localização (preferindo picking sobre overstock)
 * 2. Senão, retorna localização tipo='recebimento' do galpão
 * 3. Fallback: DEFAULT-PICKING
 */
export async function sugerirLocalizacaoPutaway(
  sb: SupabaseClient,
  ctx: PutawayContext,
): Promise<PutawaySugestao> {
  const { data: existentes } = await sb
    .from("siso_estoque")
    .select("localizacao_id, saldo, localizacao:siso_localizacoes(codigo, tipo)")
    .match({
      produto_id: ctx.produto_id,
      empresa_dona_id: ctx.empresa_id,
      galpao_id: ctx.galpao_id,
    })
    .order("saldo", { ascending: false });

  type Existente = {
    localizacao_id: string;
    saldo: number;
    localizacao?: { codigo?: string; tipo?: string };
  };
  const lista = (existentes ?? []) as Existente[];
  const candidato =
    lista.find((e) => e.localizacao?.tipo === "picking") ?? lista[0];
  if (candidato) {
    return {
      localizacao_id: candidato.localizacao_id,
      codigo: candidato.localizacao?.codigo,
      razao: "SKU já está nessa localização",
    };
  }

  const { data: recebs } = await sb
    .from("siso_localizacoes")
    .select("id, codigo")
    .match({ galpao_id: ctx.galpao_id, tipo: "recebimento", ativo: true })
    .limit(1);
  if (recebs && recebs.length > 0) {
    return {
      localizacao_id: recebs[0].id,
      codigo: recebs[0].codigo,
      razao: "área de recebimento do galpão",
    };
  }

  const { data: def } = await sb
    .from("siso_localizacoes")
    .select("id, codigo")
    .match({ galpao_id: ctx.galpao_id, codigo: "DEFAULT-PICKING" })
    .limit(1);
  if (def && def.length > 0) {
    return {
      localizacao_id: def[0].id,
      codigo: def[0].codigo,
      razao: "localização padrão (DEFAULT-PICKING)",
    };
  }

  throw new Error("nenhuma localização disponível no galpão");
}

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PutawayContext {
  produto_id: string;
  galpao_id: string;
}

export interface PutawaySugestao {
  localizacao_id: string;
  codigo?: string;
  razao: string;
}

export interface LocalExistente {
  localizacao_id: string;
  codigo: string;
  tipo: string;
  saldo: number;
}

/**
 * Lista localizações no galpão onde o produto JÁ tem saldo > 0.
 * Usado no modal de Receber pra destacar locs onde o operador pode
 * empilhar mercadoria nova em vez de criar nova posição. Ordenado por
 * saldo desc com picking antes de overstock.
 *
 * Em 3D, estoque é fungível dentro do galpão — não filtra por empresa.
 */
export async function listarLocaisExistentesProduto(
  sb: SupabaseClient,
  ctx: PutawayContext,
): Promise<LocalExistente[]> {
  const { data } = await sb
    .from("siso_estoque")
    .select(
      "localizacao_id, saldo, localizacao:siso_localizacoes(codigo, tipo)",
    )
    .match({
      produto_id: ctx.produto_id,
      galpao_id: ctx.galpao_id,
    })
    .gt("saldo", 0);
  type Row = {
    localizacao_id: string;
    saldo: number;
    localizacao?: { codigo?: string; tipo?: string };
  };
  const rows = ((data ?? []) as Row[]).filter((r) => !!r.localizacao?.codigo);
  rows.sort((a, b) => {
    // picking primeiro, depois saldo desc
    const aPick = a.localizacao?.tipo === "picking" ? 0 : 1;
    const bPick = b.localizacao?.tipo === "picking" ? 0 : 1;
    if (aPick !== bPick) return aPick - bPick;
    return Number(b.saldo) - Number(a.saldo);
  });
  return rows.map((r) => ({
    localizacao_id: r.localizacao_id,
    codigo: r.localizacao!.codigo!,
    tipo: r.localizacao!.tipo ?? "picking",
    saldo: Number(r.saldo),
  }));
}

/**
 * Heurística de sugestão de loc destino pro put-away.
 *
 * **NUNCA sugere loc tipo='recebimento'** — essa loc é a ORIGEM do put-away,
 * e usá-la como destino dispara erro "destino == origem" e deixa mov órfã
 * (bug 2026-05-19).
 *
 * 1. SKU já tem saldo em loc não-recebimento? sugere ela (preferindo picking).
 * 2. Galpão tem DEFAULT-PICKING? sugere ela.
 * 3. Senão retorna null → frontend mostra "decida no tablet" e a pendência
 *    nasce sem destino (operador escolhe ao guardar).
 *
 * Em 3D, drop filtro por empresa — estoque é fungível dentro do galpão.
 */
export async function sugerirLocalizacaoPutaway(
  sb: SupabaseClient,
  ctx: PutawayContext,
): Promise<PutawaySugestao | null> {
  const { data: existentes } = await sb
    .from("siso_estoque")
    .select("localizacao_id, saldo, localizacao:siso_localizacoes(codigo, tipo)")
    .match({
      produto_id: ctx.produto_id,
      galpao_id: ctx.galpao_id,
    })
    .gt("saldo", 0)
    .order("saldo", { ascending: false });

  // [INV-07] Loc com lock de inventário ativo (em contagem) não recebe
  // put-away — despejar estoque no meio da contagem gera interferência física
  // com o operador contando. Mesma regra de roteamento/sugestão de pick.
  const { data: locksRaw } = await sb
    .from("siso_localizacao_locks")
    .select("localizacao_id")
    .is("finalizado_em", null);
  const bloqueadas = new Set(
    ((locksRaw ?? []) as Array<{ localizacao_id: string }>).map(
      (l) => l.localizacao_id,
    ),
  );

  type Existente = {
    localizacao_id: string;
    saldo: number;
    localizacao?: { codigo?: string; tipo?: string };
  };
  const lista = ((existentes ?? []) as Existente[]).filter(
    (e) =>
      e.localizacao?.tipo &&
      e.localizacao.tipo !== "recebimento" &&
      !bloqueadas.has(e.localizacao_id),
  );
  const candidato =
    lista.find((e) => e.localizacao?.tipo === "picking") ?? lista[0];
  if (candidato) {
    return {
      localizacao_id: candidato.localizacao_id,
      codigo: candidato.localizacao?.codigo,
      razao: "SKU já está nessa localização",
    };
  }

  const { data: def } = await sb
    .from("siso_localizacoes")
    .select("id, codigo")
    .match({ galpao_id: ctx.galpao_id, codigo: "DEFAULT-PICKING" })
    .limit(1);
  if (def && def.length > 0 && !bloqueadas.has(def[0].id)) {
    return {
      localizacao_id: def[0].id,
      codigo: def[0].codigo,
      razao: "localização padrão (DEFAULT-PICKING)",
    };
  }

  return null;
}

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * - Detecta sessões `em_andamento` sem contagens nas últimas 4h → marca alerta (log)
 * - Detecta locks de localização > 30min sem contagem nova → libera o lock
 */
export async function recoveryInventario(): Promise<{
  sessoesAlerta: string[];
  locksLiberados: number;
}> {
  const sb = createServiceClient();
  const cutoff4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const cutoff30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // 1. Sessões em andamento sem atividade recente
  const { data: ativas } = await sb
    .from("siso_inventario_sessoes")
    .select("id, iniciada_em")
    .eq("status", "em_andamento");

  const alertaIds: string[] = [];
  for (const s of (ativas ?? []) as Array<{
    id: string;
    iniciada_em: string | null;
  }>) {
    const { data: ultima } = await sb
      .from("siso_inventario_contagens")
      .select("criado_em")
      .eq("sessao_id", s.id)
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ultimaTs =
      (ultima as { criado_em: string } | null)?.criado_em ?? s.iniciada_em;
    if (ultimaTs && ultimaTs < cutoff4h) {
      alertaIds.push(s.id);
      logger.warn("wms.inventario.recovery", "sessão sem atividade recente", {
        sessao_id: s.id,
        ultimaTs,
      });
    }
  }

  // 2. Locks intra-sessão > 30min sem contagem nova
  const { data: locks } = await sb
    .from("siso_inventario_localizacoes")
    .select("id, sessao_id, localizacao_id, bloqueada_em, bloqueada_por")
    .eq("status", "em_contagem")
    .lt("bloqueada_em", cutoff30m);

  let locksLiberados = 0;
  type LockRow = {
    id: string;
    sessao_id: string;
    localizacao_id: string;
    bloqueada_em: string;
    bloqueada_por: string;
  };
  for (const l of (locks ?? []) as LockRow[]) {
    const { data: ultimaCont } = await sb
      .from("siso_inventario_contagens")
      .select("criado_em")
      .eq("sessao_id", l.sessao_id)
      .eq("localizacao_id", l.localizacao_id)
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ts =
      (ultimaCont as { criado_em: string } | null)?.criado_em ?? l.bloqueada_em;
    if (ts && ts < cutoff30m) {
      await sb
        .from("siso_inventario_localizacoes")
        .update({
          bloqueada_por: null,
          bloqueada_em: null,
          status: "pendente",
        })
        .eq("id", l.id);
      locksLiberados++;
    }
  }

  return { sessoesAlerta: alertaIds, locksLiberados };
}

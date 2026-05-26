import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * Cleanup órfãos do inventário:
 * 1. Sessões em_andamento sem atividade > 4h → marca alerta (log)
 * 2. Locks de loc > 30min sem contagem → libera o lock
 * 3. Operadores ativos sem ação > 30min → força finalizado_em + libera locks
 *    cuja bloqueada_por é esse operador
 * 4. Locks cuja bloqueada_por já está finalizado (sair-party não limpou) → libera
 */
export async function recoveryInventario(): Promise<{
  sessoesAlerta: string[];
  locksLiberados: number;
  operadoresFinalizados: number;
  locksLiberadosPorFinalizado: number;
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

  // 2. Locks > 30min sem contagem nova
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

  // 3. Operadores ativos zumbi (ultima_acao_em > 30min)
  const { data: zumbis } = await sb
    .from("siso_inventario_operadores")
    .select("id, sessao_id, usuario_id, ultima_acao_em")
    .is("finalizado_em", null)
    .lt("ultima_acao_em", cutoff30m);

  let operadoresFinalizados = 0;
  let locksLiberadosPorFinalizado = 0;
  type ZumbiRow = {
    id: string;
    sessao_id: string;
    usuario_id: string;
    ultima_acao_em: string;
  };
  for (const op of (zumbis ?? []) as ZumbiRow[]) {
    // Finaliza operador (trigger BEFORE UPDATE limpa claim_*)
    await sb
      .from("siso_inventario_operadores")
      .update({ finalizado_em: new Date().toISOString() })
      .eq("id", op.id);
    operadoresFinalizados++;
    // Libera locks de loc cuja bloqueada_por é esse operador
    const { data: orphLocs } = await sb
      .from("siso_inventario_localizacoes")
      .select("id")
      .eq("sessao_id", op.sessao_id)
      .eq("bloqueada_por", op.usuario_id)
      .eq("status", "em_contagem");
    for (const ol of (orphLocs ?? []) as Array<{ id: string }>) {
      await sb
        .from("siso_inventario_localizacoes")
        .update({
          bloqueada_por: null,
          bloqueada_em: null,
          status: "pendente",
        })
        .eq("id", ol.id);
      locksLiberadosPorFinalizado++;
    }
    logger.warn("wms.inventario.recovery", "operador zumbi finalizado", {
      operador_id: op.id,
      sessao_id: op.sessao_id,
      usuario_id: op.usuario_id,
      ultima_acao_em: op.ultima_acao_em,
    });
  }

  // 4. Locks cuja bloqueada_por já está finalizado_em (sair-party deixou rastro)
  // Subquery: pega ids de loc onde bloqueada_por está finalizado nesta sessão
  const { data: locksFinalizados } = await sb.rpc(
    "wms_locks_bloqueada_por_finalizado",
  );
  if (Array.isArray(locksFinalizados)) {
    for (const id of locksFinalizados as string[]) {
      await sb
        .from("siso_inventario_localizacoes")
        .update({
          bloqueada_por: null,
          bloqueada_em: null,
          status: "pendente",
        })
        .eq("id", id);
      locksLiberadosPorFinalizado++;
    }
  }

  return {
    sessoesAlerta: alertaIds,
    locksLiberados,
    operadoresFinalizados,
    locksLiberadosPorFinalizado,
  };
}

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { descartarContagensDeLocsDevolvidas } from "@/lib/wms/inventario";

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
  const lockRows = (locks ?? []) as LockRow[];

  // [P3-15] Última atividade do operador NA SESSÃO (qualquer loc) — não só na
  // loc travada. Um operador pode ter parado nesta loc mas estar contando
  // outras na mesma sessão (vivo). Sem isso, roubávamos o lock de quem está
  // ativo-mas-lento → alimenta o P0-02 (loc devolvida, recontagem soma).
  // 1 query agregada por (sessao, operador) em vez de N+1.
  const atividadeOp = new Map<string, string>(); // `${sessao}|${user}` → max criado_em
  if (lockRows.length > 0) {
    const sessoesLock = [...new Set(lockRows.map((l) => l.sessao_id))];
    const opsLock = [...new Set(lockRows.map((l) => l.bloqueada_por))];
    const { data: contagensOp } = await sb
      .from("siso_inventario_contagens")
      .select("sessao_id, contada_por, criado_em")
      .in("sessao_id", sessoesLock)
      .in("contada_por", opsLock)
      .gte("criado_em", cutoff30m);
    for (const c of (contagensOp ?? []) as Array<{
      sessao_id: string;
      contada_por: string;
      criado_em: string;
    }>) {
      const k = `${c.sessao_id}|${c.contada_por}`;
      const prev = atividadeOp.get(k);
      if (!prev || c.criado_em > prev) atividadeOp.set(k, c.criado_em);
    }
  }

  for (const l of lockRows) {
    // [P3-15] operador com atividade na sessão < 30min → está vivo, pula a loc dele.
    const ultimaAtividade = atividadeOp.get(`${l.sessao_id}|${l.bloqueada_por}`);
    if (ultimaAtividade && ultimaAtividade >= cutoff30m) {
      continue;
    }
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
      // [P0-02] Descarta as contagens parciais ANTES de devolver a loc ao
      // pool — sem isso o próximo claimer conta do zero e o computar SOMA as
      // duas tentativas (estoque fantasma). Falhou o descarte → não libera a
      // loc neste ciclo (cron tenta de novo em 30min).
      try {
        await descartarContagensDeLocsDevolvidas(
          sb,
          l.sessao_id,
          [l.localizacao_id],
          "recovery_lock_30min",
        );
      } catch (e) {
        logger.warn(
          "wms.inventario.recovery",
          "falha ao descartar contagens da loc — liberação adiada pro próximo ciclo",
          { inv_loc_id: l.id, sessao_id: l.sessao_id, error: String(e) },
        );
        continue;
      }
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
      .select("id, localizacao_id")
      .eq("sessao_id", op.sessao_id)
      .eq("bloqueada_por", op.usuario_id)
      .eq("status", "em_contagem");
    for (const ol of (orphLocs ?? []) as Array<{
      id: string;
      localizacao_id: string;
    }>) {
      // [P0-02] mesmo descarte do bloco de locks 30min (loc regride pra pendente).
      try {
        await descartarContagensDeLocsDevolvidas(
          sb,
          op.sessao_id,
          [ol.localizacao_id],
          "recovery_operador_zumbi",
        );
      } catch (e) {
        logger.warn(
          "wms.inventario.recovery",
          "falha ao descartar contagens da loc — liberação adiada pro próximo ciclo",
          { inv_loc_id: ol.id, sessao_id: op.sessao_id, error: String(e) },
        );
        continue;
      }
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
  if (Array.isArray(locksFinalizados) && locksFinalizados.length > 0) {
    // [P0-02] precisa de (sessao_id, localizacao_id) pra descartar as
    // contagens da tentativa abandonada antes de devolver a loc ao pool.
    const { data: rowsFinalizados } = await sb
      .from("siso_inventario_localizacoes")
      .select("id, sessao_id, localizacao_id")
      .in("id", locksFinalizados as string[]);
    for (const r of (rowsFinalizados ?? []) as Array<{
      id: string;
      sessao_id: string;
      localizacao_id: string;
    }>) {
      try {
        await descartarContagensDeLocsDevolvidas(
          sb,
          r.sessao_id,
          [r.localizacao_id],
          "recovery_lock_finalizado",
        );
      } catch (e) {
        logger.warn(
          "wms.inventario.recovery",
          "falha ao descartar contagens da loc — liberação adiada pro próximo ciclo",
          { inv_loc_id: r.id, sessao_id: r.sessao_id, error: String(e) },
        );
        continue;
      }
      await sb
        .from("siso_inventario_localizacoes")
        .update({
          bloqueada_por: null,
          bloqueada_em: null,
          status: "pendente",
        })
        .eq("id", r.id);
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

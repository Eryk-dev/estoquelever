import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import type { TipoMov } from "./types";

export type TipoSessao = "cycle_count" | "completo";
export type ModoContagem = "aberto" | "blind" | "duplo_blind";
export type StatusSessao =
  | "planejada"
  | "em_andamento"
  | "revisao"
  | "aprovada"
  | "aplicada"
  | "cancelada";

export interface CriarSessaoInput {
  tipo: TipoSessao;
  galpao_id: string;
  empresa_dona_id?: string;
  modo_contagem?: ModoContagem;
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  programada_para?: string;
  observacoes?: string;
  criada_por: string;
  areas: { nome: string; operador_id?: string; localizacao_ids: string[] }[];
}

export async function criarSessaoInventario(
  input: CriarSessaoInput,
): Promise<string> {
  const sb = createServiceClient();
  const { data: sessao, error } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      tipo: input.tipo,
      galpao_id: input.galpao_id,
      empresa_dona_id: input.empresa_dona_id,
      modo_contagem: input.modo_contagem ?? "blind",
      tolerancia_pct: input.tolerancia_pct ?? 2.0,
      tolerancia_qty_min: input.tolerancia_qty_min ?? 0,
      exige_aprovacao_acima_valor: input.exige_aprovacao_acima_valor ?? 1000,
      programada_para: input.programada_para,
      observacoes: input.observacoes,
      criada_por: input.criada_por,
    })
    .select()
    .single();
  if (error) throw error;
  const sessaoId = (sessao as { id: string }).id;

  for (const a of input.areas) {
    const { data: area, error: errA } = await sb
      .from("siso_inventario_areas")
      .insert({ sessao_id: sessaoId, nome: a.nome, operador_id: a.operador_id })
      .select()
      .single();
    if (errA) throw errA;
    if (a.localizacao_ids.length > 0) {
      const rows = a.localizacao_ids.map((loc_id) => ({
        sessao_id: sessaoId,
        area_id: (area as { id: string }).id,
        localizacao_id: loc_id,
      }));
      const { error: errL } = await sb
        .from("siso_inventario_localizacoes")
        .insert(rows);
      if (errL) throw errL;
    }
  }
  return sessaoId;
}

export async function iniciarSessao(
  sessaoId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();

  const { data: sessao, error } = await sb
    .from("siso_inventario_sessoes")
    .select("status")
    .eq("id", sessaoId)
    .single();
  if (error || !sessao) throw new Error("sessão não encontrada");
  if ((sessao as { status: string }).status !== "planejada") {
    throw new Error(
      `sessão não está em status 'planejada' (atual: ${(sessao as { status: string }).status})`,
    );
  }

  const { data: locs } = await sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id")
    .eq("sessao_id", sessaoId);

  const lockRows = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
    (l) => ({
      localizacao_id: l.localizacao_id,
      motivo: "cycle_count",
      iniciado_por: usuarioId,
    }),
  );
  if (lockRows.length > 0) {
    const { error: errLock } = await sb
      .from("siso_localizacao_locks")
      .insert(lockRows);
    if (errLock) throw errLock;
  }

  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "em_andamento", iniciada_em: new Date().toISOString() })
    .eq("id", sessaoId);
}

export async function pegarLocalizacao(
  sessaoId: string,
  localizacaoId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.rpc("wms_inventario_pegar_localizacao", {
    p_sessao: sessaoId,
    p_localizacao: localizacaoId,
    p_user: usuarioId,
  });
  if (error) throw error;
}

export async function liberarLocalizacao(
  sessaoId: string,
  localizacaoId: string,
): Promise<void> {
  const sb = createServiceClient();
  await sb
    .from("siso_inventario_localizacoes")
    .update({ bloqueada_por: null, bloqueada_em: null, status: "contada" })
    .eq("sessao_id", sessaoId)
    .eq("localizacao_id", localizacaoId);
}

export interface RegistrarContagemInput {
  sessao_id: string;
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  qty_contada: number;
  contada_por: string;
  /**
   * - "incremental" (default): cada bipe soma +qty na contagem do operador.
   * - "absoluto": substitui contagem prévia do operador por qty_contada.
   */
  modo?: "incremental" | "absoluto";
}

export async function registrarContagem(
  input: RegistrarContagemInput,
): Promise<void> {
  const sb = createServiceClient();
  const modo = input.modo ?? "incremental";

  const filtro = {
    sessao_id: input.sessao_id,
    localizacao_id: input.localizacao_id,
    produto_id: input.produto_id,
    empresa_dona_id: input.empresa_dona_id,
  };

  const { data: existentes } = await sb
    .from("siso_inventario_contagens")
    .select("id, qty_contada, rodada, contada_por")
    .match(filtro);

  type Contagem = {
    id: string;
    qty_contada: number;
    rodada: number;
    contada_por: string;
  };
  const lista = (existentes ?? []) as Contagem[];
  const minhaContagem = lista.find((e) => e.contada_por === input.contada_por);
  const rodada = minhaContagem
    ? minhaContagem.rodada
    : lista.length > 0
      ? Math.max(...lista.map((e) => e.rodada)) + 1
      : 1;

  if (modo === "incremental" && minhaContagem) {
    const { error } = await sb
      .from("siso_inventario_contagens")
      .update({
        qty_contada: Number(minhaContagem.qty_contada) + input.qty_contada,
      })
      .eq("id", minhaContagem.id);
    if (error) throw error;
    return;
  }

  if (modo === "absoluto" && minhaContagem) {
    const { error } = await sb
      .from("siso_inventario_contagens")
      .update({ qty_contada: input.qty_contada })
      .eq("id", minhaContagem.id);
    if (error) throw error;
    return;
  }

  const { error } = await sb.from("siso_inventario_contagens").insert({
    ...filtro,
    qty_contada: input.qty_contada,
    contada_por: input.contada_por,
    rodada,
  });
  if (error) throw error;
}

export async function computarDivergencias(sessaoId: string): Promise<void> {
  const sb = createServiceClient();
  const { data: contagens } = await sb
    .from("siso_inventario_contagens")
    .select(
      "localizacao_id, produto_id, empresa_dona_id, qty_contada, rodada, criado_em",
    )
    .eq("sessao_id", sessaoId)
    .order("rodada", { ascending: false })
    .order("criado_em", { ascending: false });

  if (!contagens) return;

  type ContagemRow = {
    localizacao_id: string;
    produto_id: string;
    empresa_dona_id: string;
    qty_contada: number;
    rodada: number;
    criado_em: string;
  };
  const map = new Map<
    string,
    {
      localizacao_id: string;
      produto_id: string;
      empresa_dona_id: string;
      qty: number;
    }
  >();
  for (const c of contagens as ContagemRow[]) {
    const k = `${c.localizacao_id}|${c.produto_id}|${c.empresa_dona_id}`;
    if (!map.has(k)) {
      map.set(k, {
        localizacao_id: c.localizacao_id,
        produto_id: c.produto_id,
        empresa_dona_id: c.empresa_dona_id,
        qty: Number(c.qty_contada),
      });
    }
  }

  const { data: sessao } = await sb
    .from("siso_inventario_sessoes")
    .select("tolerancia_pct, tolerancia_qty_min, exige_aprovacao_acima_valor")
    .eq("id", sessaoId)
    .single();
  const s = sessao as {
    tolerancia_pct: number;
    tolerancia_qty_min: number;
    exige_aprovacao_acima_valor: number | null;
  } | null;

  for (const v of map.values()) {
    const { data: estoque } = await sb
      .from("siso_estoque")
      .select("saldo, custo_medio")
      .match({
        produto_id: v.produto_id,
        empresa_dona_id: v.empresa_dona_id,
        localizacao_id: v.localizacao_id,
      })
      .maybeSingle();
    const e = estoque as { saldo: number; custo_medio: number } | null;
    const saldo_sistema = Number(e?.saldo ?? 0);
    const delta = v.qty - saldo_sistema;
    const delta_pct =
      saldo_sistema === 0 ? null : Math.abs((delta / saldo_sistema) * 100);
    const valor_financeiro = Number(e?.custo_medio ?? 0) * delta;

    let status: "aprovada" | "pendente" = "aprovada";
    if (delta !== 0) {
      const dentroTol =
        (s?.tolerancia_pct ?? 0) > 0 && delta_pct !== null
          ? delta_pct <= s!.tolerancia_pct
          : Math.abs(delta) <= (s?.tolerancia_qty_min ?? 0);
      const acimaValor =
        s?.exige_aprovacao_acima_valor != null &&
        Math.abs(valor_financeiro) > Number(s.exige_aprovacao_acima_valor);
      status = dentroTol && !acimaValor ? "aprovada" : "pendente";
    }

    await sb
      .from("siso_inventario_divergencias")
      .upsert(
        {
          sessao_id: sessaoId,
          localizacao_id: v.localizacao_id,
          produto_id: v.produto_id,
          empresa_dona_id: v.empresa_dona_id,
          saldo_sistema,
          qty_contada_final: v.qty,
          valor_financeiro,
          status,
        },
        { onConflict: "sessao_id,localizacao_id,produto_id,empresa_dona_id" },
      );
  }

  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "revisao", finalizada_em: new Date().toISOString() })
    .eq("id", sessaoId);
}

export async function aprovarSessao(
  sessaoId: string,
  aprovadaPor: string,
): Promise<void> {
  const sb = createServiceClient();
  const { data: pendentes } = await sb
    .from("siso_inventario_divergencias")
    .select("id")
    .eq("sessao_id", sessaoId)
    .eq("status", "pendente")
    .limit(1);
  if (pendentes && pendentes.length > 0) {
    throw new Error(
      "ainda há divergências pendentes; resolva antes de aprovar",
    );
  }
  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "aprovada", aprovada_por: aprovadaPor })
    .eq("id", sessaoId);
}

export async function aplicarSessao(
  sessaoId: string,
  usuarioId: string,
): Promise<{ movsGeradas: number }> {
  const sb = createServiceClient();
  const { data: sessao } = await sb
    .from("siso_inventario_sessoes")
    .select("status, galpao_id")
    .eq("id", sessaoId)
    .single();
  if (!sessao) throw new Error("sessão não encontrada");
  const s = sessao as { status: string; galpao_id: string };
  if (s.status !== "aprovada") throw new Error("sessão não está aprovada");

  const { data: divergencias } = await sb
    .from("siso_inventario_divergencias")
    .select("*")
    .eq("sessao_id", sessaoId)
    .eq("status", "aprovada");

  type DivRow = {
    id: string;
    produto_id: string;
    empresa_dona_id: string;
    localizacao_id: string;
    delta: number;
    delta_pct: number | null;
  };

  let movsGeradas = 0;
  for (const d of (divergencias ?? []) as DivRow[]) {
    if (Number(d.delta) === 0) continue;
    const tipo: TipoMov = Number(d.delta) > 0 ? "E" : "S";
    const qty = Math.abs(Number(d.delta));
    const mov = await inserirMovimentacao({
      quadrupla: {
        produto_id: d.produto_id,
        empresa_dona_id: d.empresa_dona_id,
        galpao_id: s.galpao_id,
        localizacao_id: d.localizacao_id,
      },
      tipo,
      qty,
      origem_tipo: "inventario",
      origem_id: sessaoId,
      origem_detalhes: { divergencia_id: d.id, delta_pct: d.delta_pct },
      usuario_id: usuarioId,
      observacoes: `inventário sessão ${sessaoId}`,
    });
    await sb
      .from("siso_inventario_divergencias")
      .update({ status: "aplicada", mov_aplicada_id: mov.id })
      .eq("id", d.id);
    movsGeradas++;
  }

  // Libera locks da sessão
  const { data: locs } = await sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id")
    .eq("sessao_id", sessaoId);
  const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
    (l) => l.localizacao_id,
  );
  if (locIds.length > 0) {
    await sb
      .from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locIds)
      .is("finalizado_em", null);
  }

  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "aplicada", aplicada_em: new Date().toISOString() })
    .eq("id", sessaoId);

  return { movsGeradas };
}

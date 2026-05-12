import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import type { TipoMov } from "./types";

export type TipoSessao = "cycle_count" | "completo";
export type ModoContagem = "aberto" | "blind";
export type StatusSessao =
  | "planejada"
  | "em_andamento"
  | "revisao"
  | "aprovada"
  | "aplicada"
  | "cancelada";
export type MotivoLoc =
  | "curva_a"
  | "divergente_recente"
  | "sem_contagem_recente"
  | "manual"
  | "completo";

// ─────────────────────────────────────────────────────────────────────
// Criação de sessão
// ─────────────────────────────────────────────────────────────────────

export interface LocSessaoInput {
  localizacao_id: string;
  motivo?: MotivoLoc;
  /** Slot do operador (1..5) ao qual essa loc fica pré-atribuída.
   *  Quando NULL, a loc entra no pool comum (smart routing decide o owner).
   *  Quando setado, o RPC wms_inventario_proxima_loc prioriza essa loc pro
   *  operador que está no slot correspondente; quando o bucket esvazia,
   *  caí naturalmente nas regras de continuidade/anti-colisão. */
  slot_atribuido?: number | null;
}

export interface CriarSessaoInput {
  tipo: TipoSessao;
  nome?: string;
  galpao_id: string;
  empresa_dona_id?: string | null;
  modo_contagem?: ModoContagem;
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
  criada_por: string;
  localizacoes: LocSessaoInput[];
  /** Quantos slots de operador a sessão expõe (1..5). Default 5.
   *  A tela handheld só mostra slots OP1..OP{num_operadores}. */
  num_operadores?: number;
}

export async function criarSessao(input: CriarSessaoInput): Promise<string> {
  if (input.localizacoes.length === 0) {
    throw new Error("sessão precisa de pelo menos uma localização");
  }
  const sb = createServiceClient();
  const numOps =
    input.num_operadores != null &&
    Number.isInteger(input.num_operadores) &&
    input.num_operadores >= 1 &&
    input.num_operadores <= 5
      ? input.num_operadores
      : 5;
  const { data: sessao, error } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      tipo: input.tipo,
      nome: input.nome ?? null,
      galpao_id: input.galpao_id,
      empresa_dona_id: input.empresa_dona_id ?? null,
      modo_contagem: input.modo_contagem ?? "blind",
      tolerancia_pct: input.tolerancia_pct ?? 2.0,
      tolerancia_qty_min: input.tolerancia_qty_min ?? 0,
      exige_aprovacao_acima_valor: input.exige_aprovacao_acima_valor ?? 1000,
      observacoes: input.observacoes ?? null,
      criada_por: input.criada_por,
      tamanho_pool: input.localizacoes.length,
      num_operadores: numOps,
    })
    .select("id")
    .single();
  if (error) throw error;
  const sessaoId = (sessao as { id: string }).id;

  const rows = input.localizacoes.map((l) => ({
    sessao_id: sessaoId,
    localizacao_id: l.localizacao_id,
    motivo: l.motivo ?? "manual",
    slot_atribuido:
      l.slot_atribuido != null &&
      Number.isInteger(l.slot_atribuido) &&
      l.slot_atribuido >= 1 &&
      l.slot_atribuido <= 5
        ? l.slot_atribuido
        : null,
  }));

  const { error: errL } = await sb
    .from("siso_inventario_localizacoes")
    .insert(rows);
  if (errL) {
    // Rollback: a sessão sem locs é inútil. Cancela.
    await sb
      .from("siso_inventario_sessoes")
      .update({ status: "cancelada" })
      .eq("id", sessaoId);
    throw errL;
  }
  return sessaoId;
}

// ─────────────────────────────────────────────────────────────────────
// Sugestão inteligente (RPC: wms_inventario_sugerir)
// ─────────────────────────────────────────────────────────────────────

export interface SugerirInput {
  galpao_id: string;
  empresa_dona_id?: string | null;
  tamanho?: number;
}

export interface SugestaoLoc {
  localizacao_id: string;
  codigo: string;
  motivo: MotivoLoc;
  score: number;
}

export async function sugerirLocalizacoes(
  input: SugerirInput,
): Promise<SugestaoLoc[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_inventario_sugerir", {
    p_galpao: input.galpao_id,
    p_empresa_dona: input.empresa_dona_id ?? null,
    p_tamanho: input.tamanho ?? 30,
  });
  if (error) throw error;
  return ((data ?? []) as SugestaoLoc[]).map((r) => ({
    localizacao_id: r.localizacao_id,
    codigo: r.codigo,
    motivo: r.motivo,
    score: Number(r.score),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// Início de sessão (idempotente — pode ser chamado pelo supervisor OU
// auto-disparado pelo primeiro operador que entra num slot).
// ─────────────────────────────────────────────────────────────────────

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
  const status = (sessao as { status: StatusSessao }).status;

  if (status === "em_andamento") return; // idempotente
  if (status !== "planejada") {
    throw new Error(
      `sessão não pode ser iniciada (status atual: ${status})`,
    );
  }

  // Cria locks externos pras locs desta sessão (impede outras operações)
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
    // ON CONFLICT DO NOTHING via upsert/ignore — locks existentes não duplicam
    const { error: errLock } = await sb
      .from("siso_localizacao_locks")
      .insert(lockRows);
    if (errLock && errLock.code !== "23505") throw errLock;
  }

  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "em_andamento", iniciada_em: new Date().toISOString() })
    .eq("id", sessaoId);
}

// ─────────────────────────────────────────────────────────────────────
// Slots de operador (OP1..OP5)
// ─────────────────────────────────────────────────────────────────────

export async function entrarSlot(
  sessaoId: string,
  slot: number,
  usuarioId: string,
): Promise<void> {
  if (slot < 1 || slot > 5) throw new Error("slot deve estar entre 1 e 5");
  const sb = createServiceClient();

  // Valida que o slot está dentro do limite configurado na sessão.
  // Sessões antigas (sem coluna ou NULL) usam o default 5.
  const { data: sessaoCfg } = await sb
    .from("siso_inventario_sessoes")
    .select("num_operadores")
    .eq("id", sessaoId)
    .single();
  const numOps =
    (sessaoCfg as { num_operadores?: number | null } | null)?.num_operadores ?? 5;
  if (slot > numOps) {
    throw new Error(
      `essa sessão foi configurada pra ${numOps} operador${numOps > 1 ? "es" : ""} — OP${slot} não está disponível`,
    );
  }

  // Auto-start: se sessão tá planejada, inicia (idempotente)
  await iniciarSessao(sessaoId, usuarioId);

  // Insere operador no slot — UNIQUE constraint (sessao_id, slot) trava colisão
  const { error } = await sb.from("siso_inventario_operadores").insert({
    sessao_id: sessaoId,
    slot,
    usuario_id: usuarioId,
  });
  if (error) {
    if (error.code === "23505") {
      throw new Error("slot já está ocupado ou você já está em outro slot");
    }
    throw error;
  }
}

export async function sairSlot(
  sessaoId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();
  await sb
    .from("siso_inventario_operadores")
    .update({ finalizado_em: new Date().toISOString() })
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .is("finalizado_em", null);
}

// ─────────────────────────────────────────────────────────────────────
// Pull queue: puxar próxima loc (RPC com smart routing + lock atômico)
// ─────────────────────────────────────────────────────────────────────

export interface EsperadoItem {
  produto_id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  imagens: string[];
  saldo_esperado: number;
  empresa_dona_id: string;
}

export interface ProximaLocOutput {
  pool_vazio: boolean;
  inv_loc_id?: string;
  loc_id?: string;
  codigo?: string;
  tipo?: string;
  zona?: string;
  modo?: ModoContagem;
  esperados?: EsperadoItem[];
}

export async function pegarProximaLoc(
  sessaoId: string,
  usuarioId: string,
): Promise<ProximaLocOutput> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_inventario_proxima_loc", {
    p_sessao: sessaoId,
    p_user: usuarioId,
  });
  if (error) throw error;
  const r = (data ?? {}) as {
    ok?: boolean;
    pool_vazio?: boolean;
    inv_loc_id?: string;
    loc_id?: string;
    codigo?: string;
    tipo?: string;
    zona?: string;
    modo?: ModoContagem;
    esperados?: EsperadoItem[] | null;
  };
  // Enriquece esperados com imagem_url — RPC não retorna pra evitar bloat
  // no payload de roteamento; aqui é a hora de pagar o lookup (lista
  // pequena, normalmente <10 SKUs por loc) pra ajudar o operador a
  // identificar visualmente a peça no handheld.
  let esperadosEnriched = r.esperados ?? undefined;
  if (esperadosEnriched && esperadosEnriched.length > 0) {
    const ids = esperadosEnriched.map((e) => e.produto_id);
    const { data: imgs } = await sb
      .from("siso_produtos")
      .select("id, imagem_url, imagens")
      .in("id", ids);
    const imgMap = new Map(
      ((imgs ?? []) as Array<{
        id: string;
        imagem_url: string | null;
        imagens: string[] | null;
      }>).map((p) => [
        p.id,
        { imagem_url: p.imagem_url, imagens: p.imagens ?? [] },
      ]),
    );
    esperadosEnriched = esperadosEnriched.map((e) => {
      const m = imgMap.get(e.produto_id);
      return {
        ...e,
        imagem_url: m?.imagem_url ?? null,
        imagens: m?.imagens ?? [],
      };
    });
  }

  return {
    pool_vazio: r.pool_vazio === true,
    inv_loc_id: r.inv_loc_id,
    loc_id: r.loc_id,
    codigo: r.codigo,
    tipo: r.tipo,
    zona: r.zona,
    modo: r.modo,
    esperados: esperadosEnriched,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Finalizar loc: marca como contada e libera o lock; incrementa operador
// ─────────────────────────────────────────────────────────────────────

export async function finalizarLoc(
  sessaoId: string,
  invLocId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();

  // Confirma que o user é dono do lock dessa loc
  const { data: invLoc } = await sb
    .from("siso_inventario_localizacoes")
    .select("id, bloqueada_por, status")
    .eq("id", invLocId)
    .eq("sessao_id", sessaoId)
    .single();
  const row = invLoc as {
    id: string;
    bloqueada_por: string | null;
    status: string;
  } | null;
  if (!row) throw new Error("localização não encontrada na sessão");
  if (row.bloqueada_por !== usuarioId) {
    throw new Error("apenas o operador que bloqueou pode finalizar");
  }
  if (row.status !== "em_contagem") {
    throw new Error(`status inesperado: ${row.status}`);
  }

  const { error } = await sb
    .from("siso_inventario_localizacoes")
    .update({
      status: "contada",
      bloqueada_por: null,
      bloqueada_em: null,
      contagem_finalizada_em: new Date().toISOString(),
    })
    .eq("id", invLocId);
  if (error) throw error;

  // Incrementa contador do operador (best-effort)
  const { data: op } = await sb
    .from("siso_inventario_operadores")
    .select("id, locs_contadas")
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .is("finalizado_em", null)
    .single();
  if (op) {
    await sb
      .from("siso_inventario_operadores")
      .update({
        locs_contadas: ((op as { locs_contadas: number }).locs_contadas ?? 0) + 1,
        ultima_acao_em: new Date().toISOString(),
      })
      .eq("id", (op as { id: string }).id);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Contagem (cada bipe)
// ─────────────────────────────────────────────────────────────────────

export interface RegistrarContagemInput {
  sessao_id: string;
  localizacao_id: string;
  produto_id: string;
  empresa_dona_id: string;
  qty_contada: number;
  contada_por: string;
  /**
   * - "incremental" (default): soma +qty na contagem deste operador na mesma quádrupla.
   * - "absoluto": substitui contagem prévia.
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
    contada_por: input.contada_por,
  };

  // Procura contagem prévia deste operador na mesma quádrupla
  const { data: existente } = await sb
    .from("siso_inventario_contagens")
    .select("id, qty_contada")
    .match(filtro)
    .maybeSingle();

  type Contagem = { id: string; qty_contada: number };
  const prev = existente as Contagem | null;

  if (prev) {
    const novoQty =
      modo === "incremental"
        ? Number(prev.qty_contada) + input.qty_contada
        : input.qty_contada;
    const { error } = await sb
      .from("siso_inventario_contagens")
      .update({ qty_contada: novoQty })
      .eq("id", prev.id);
    if (error) throw error;
    return;
  }

  const { error } = await sb.from("siso_inventario_contagens").insert({
    sessao_id: input.sessao_id,
    localizacao_id: input.localizacao_id,
    produto_id: input.produto_id,
    empresa_dona_id: input.empresa_dona_id,
    qty_contada: input.qty_contada,
    contada_por: input.contada_por,
  });
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────
// Computar divergências (sessão → revisão)
// Soma todas as contagens da quádrupla (vários operadores combinam),
// compara com saldo do sistema, classifica conforme tolerância.
//
// Modo parcial: só considera locs efetivamente finalizadas (contada|aprovada).
// Locs pendentes/em_contagem ficam intocadas — seus locks externos são
// liberados normalmente em aprovarSessao junto com as outras.
// ─────────────────────────────────────────────────────────────────────

export interface ComputarDivergenciasOpts {
  parcial?: boolean;
}

export async function computarDivergencias(
  sessaoId: string,
  opts: ComputarDivergenciasOpts = {},
): Promise<void> {
  const sb = createServiceClient();
  const parcial = opts.parcial === true;

  // Em modo parcial, só consideramos locs finalizadas (contada|aprovada).
  // As pendentes/em_contagem são puladas — contagens órfãs delas não viram diverg.
  let locsConsideradasIds: string[] | null = null;
  if (parcial) {
    const { data: locsFinalizadas } = await sb
      .from("siso_inventario_localizacoes")
      .select("localizacao_id")
      .eq("sessao_id", sessaoId)
      .in("status", ["contada", "aprovada"]);
    locsConsideradasIds = (
      (locsFinalizadas ?? []) as Array<{ localizacao_id: string }>
    ).map((l) => l.localizacao_id);
    if (locsConsideradasIds.length === 0) {
      // Nada pra processar — só avança o status pra revisao e fecha slots
      await sb
        .from("siso_inventario_sessoes")
        .update({
          status: "revisao",
          finalizada_em: new Date().toISOString(),
        })
        .eq("id", sessaoId);
      await sb
        .from("siso_inventario_operadores")
        .update({ finalizado_em: new Date().toISOString() })
        .eq("sessao_id", sessaoId)
        .is("finalizado_em", null);
      return;
    }
  }

  let contagensQuery = sb
    .from("siso_inventario_contagens")
    .select("localizacao_id, produto_id, empresa_dona_id, qty_contada")
    .eq("sessao_id", sessaoId);
  if (locsConsideradasIds) {
    contagensQuery = contagensQuery.in("localizacao_id", locsConsideradasIds);
  }
  const { data: contagens } = await contagensQuery;

  type ContagemRow = {
    localizacao_id: string;
    produto_id: string;
    empresa_dona_id: string;
    qty_contada: number;
  };

  // Agrega: soma qty por quádrupla (vários operadores podem ter contado a mesma)
  const agregado = new Map<
    string,
    {
      localizacao_id: string;
      produto_id: string;
      empresa_dona_id: string;
      qty: number;
    }
  >();
  for (const c of (contagens ?? []) as ContagemRow[]) {
    const k = `${c.localizacao_id}|${c.produto_id}|${c.empresa_dona_id}`;
    const cur = agregado.get(k);
    if (cur) {
      cur.qty += Number(c.qty_contada);
    } else {
      agregado.set(k, {
        localizacao_id: c.localizacao_id,
        produto_id: c.produto_id,
        empresa_dona_id: c.empresa_dona_id,
        qty: Number(c.qty_contada),
      });
    }
  }

  // Detecta locs com saldo > 0 que ninguém bipou — geram divergência (qty=0).
  // Em modo parcial, só considera locs finalizadas (já filtradas em locsConsideradasIds).
  let locIds: string[];
  if (locsConsideradasIds) {
    locIds = locsConsideradasIds;
  } else {
    const { data: locsSessao } = await sb
      .from("siso_inventario_localizacoes")
      .select("localizacao_id")
      .eq("sessao_id", sessaoId);
    locIds = ((locsSessao ?? []) as Array<{ localizacao_id: string }>).map(
      (l) => l.localizacao_id,
    );
  }

  if (locIds.length > 0) {
    let estoqueQuery = sb
      .from("siso_estoque")
      .select("produto_id, empresa_dona_id, localizacao_id, saldo")
      .in("localizacao_id", locIds)
      .gt("saldo", 0);

    const { data: sessao } = await sb
      .from("siso_inventario_sessoes")
      .select("empresa_dona_id")
      .eq("id", sessaoId)
      .single();
    const empresaDona = (sessao as { empresa_dona_id: string | null } | null)
      ?.empresa_dona_id;
    if (empresaDona) {
      estoqueQuery = estoqueQuery.eq("empresa_dona_id", empresaDona);
    }
    const { data: estoque } = await estoqueQuery;
    type EstoqueRow = {
      produto_id: string;
      empresa_dona_id: string;
      localizacao_id: string;
      saldo: number;
    };
    for (const e of (estoque ?? []) as EstoqueRow[]) {
      const k = `${e.localizacao_id}|${e.produto_id}|${e.empresa_dona_id}`;
      if (!agregado.has(k)) {
        // Ninguém bipou esse SKU/dona/loc → conta como qty=0 (sumiu)
        agregado.set(k, {
          localizacao_id: e.localizacao_id,
          produto_id: e.produto_id,
          empresa_dona_id: e.empresa_dona_id,
          qty: 0,
        });
      }
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

  for (const v of agregado.values()) {
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

    // delta === 0 não é divergência — pula. Se existia uma linha
    // anterior (re-run), remove pra não poluir a UI.
    if (delta === 0) {
      await sb
        .from("siso_inventario_divergencias")
        .delete()
        .match({
          sessao_id: sessaoId,
          localizacao_id: v.localizacao_id,
          produto_id: v.produto_id,
          empresa_dona_id: v.empresa_dona_id,
        })
        .neq("status", "aplicada");
      continue;
    }

    const delta_pct =
      saldo_sistema === 0 ? null : Math.abs((delta / saldo_sistema) * 100);
    const valor_financeiro = Number(e?.custo_medio ?? 0) * delta;

    const dentroTol =
      (s?.tolerancia_pct ?? 0) > 0 && delta_pct !== null
        ? delta_pct <= s!.tolerancia_pct
        : Math.abs(delta) <= (s?.tolerancia_qty_min ?? 0);
    const acimaValor =
      s?.exige_aprovacao_acima_valor != null &&
      Math.abs(valor_financeiro) > Number(s.exige_aprovacao_acima_valor);
    const status: "aprovada" | "pendente" =
      dentroTol && !acimaValor ? "aprovada" : "pendente";

    await sb.from("siso_inventario_divergencias").upsert(
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

  // Fecha slots dos operadores ainda ativos
  await sb
    .from("siso_inventario_operadores")
    .update({ finalizado_em: new Date().toISOString() })
    .eq("sessao_id", sessaoId)
    .is("finalizado_em", null);
}

// ─────────────────────────────────────────────────────────────────────
// Aprovar sessão (após resolver divergências)
// ─────────────────────────────────────────────────────────────────────

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

  // Libera locks externos. Aplicação (gerar movs) é só ato contábil —
  // não precisa segurar lock contra outras sessões.
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
}

// ─────────────────────────────────────────────────────────────────────
// Aplicar sessão → gera movimentações no ledger
// ─────────────────────────────────────────────────────────────────────

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

// Alias retrocompat — alguns callers ainda importam o nome antigo.
export const criarSessaoInventario = criarSessao;

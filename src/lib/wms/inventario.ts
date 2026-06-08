import { createServiceClient } from "@/lib/supabase-server";
import { estornarMovimentacao } from "./ledger";
import { reconciliarTemporal, janelaInferiorReconciliacao } from "./inventario-reconciliacao";
import { logger } from "@/lib/logger";

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
}

export interface CriarSessaoInput {
  tipo: TipoSessao;
  nome?: string;
  galpao_id: string;
  modo_contagem?: ModoContagem;
  tolerancia_pct?: number;
  tolerancia_qty_min?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
  criada_por: string;
  /**
   * Token gerado pelo cliente uma vez por intenção de criação. Os dois requests
   * de um duplo-clique acidental carregam a MESMA key → o 2º colide no índice
   * único parcial `uq_inv_sessao_idempotency` e devolve a sessão já criada (no-op
   * idempotente). Uma 2ª sessão intencional usa key nova e passa normal. Ausente
   * (cliente antigo) ⇒ sem dedup, sem limite por dia. Substitui o limite P055.
   */
  idempotencyKey?: string;
  localizacoes: LocSessaoInput[];
}

export async function criarSessao(input: CriarSessaoInput): Promise<string> {
  if (input.localizacoes.length === 0) {
    throw new Error("sessão precisa de pelo menos uma localização");
  }
  const sb = createServiceClient();
  const { data: sessao, error } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      tipo: input.tipo,
      nome: input.nome ?? null,
      galpao_id: input.galpao_id,
      modo_contagem: input.modo_contagem ?? "blind",
      tolerancia_pct: input.tolerancia_pct ?? 2.0,
      tolerancia_qty_min: input.tolerancia_qty_min ?? 0,
      exige_aprovacao_acima_valor: input.exige_aprovacao_acima_valor ?? 1000,
      observacoes: input.observacoes ?? null,
      criada_por: input.criada_por,
      tamanho_pool: input.localizacoes.length,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 com idempotencyKey = duplo-clique: a 1ª request já criou a sessão.
    // Devolve o id dela (idempotente) em vez de duplicar ou estourar erro.
    if ((error as { code?: string }).code === "23505" && input.idempotencyKey) {
      const { data: existente, error: errFind } = await sb
        .from("siso_inventario_sessoes")
        .select("id")
        .eq("idempotency_key", input.idempotencyKey)
        .single();
      if (!errFind && existente) return (existente as { id: string }).id;
    }
    throw error;
  }
  const sessaoId = (sessao as { id: string }).id;

  const rows = input.localizacoes.map((l) => ({
    sessao_id: sessaoId,
    localizacao_id: l.localizacao_id,
    motivo: l.motivo ?? "manual",
  }));

  const { error: errL } = await sb
    .from("siso_inventario_localizacoes")
    .insert(rows);
  if (errL) {
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
// Party de operadores (modelo dinâmico — substitui slots numerados)
// ─────────────────────────────────────────────────────────────────────

export type AcaoEntradaParty =
  | { tipo: "no-op" }
  | { tipo: "reativar"; id: string }
  | { tipo: "criar" };

/** Decide o que fazer quando um usuário tenta entrar na party. Função
 *  pura — não toca DB. Permite testar a lógica de reentrada sem mock. */
export function decidirAcaoEntrada(
  existente: { id: string; finalizado_em: string | null } | null,
): AcaoEntradaParty {
  if (!existente) return { tipo: "criar" };
  if (existente.finalizado_em === null) return { tipo: "no-op" };
  return { tipo: "reativar", id: existente.id };
}

export async function entrarParty(
  sessaoId: string,
  usuarioId: string,
): Promise<{ retomado: boolean }> {
  const sb = createServiceClient();

  // Auto-start: se sessão tá planejada, inicia (idempotente)
  await iniciarSessao(sessaoId, usuarioId);

  // Existe registro deste usuário nesta sessão? Defensivo contra dados
  // legados do modelo slot — quando o user podia ter múltiplas linhas
  // finalizadas pra mesma sessão (uma por slot diferente). UNIQUE parcial
  // garante no máximo 1 ativa, mas podem coexistir N finalizadas. Preferimos
  // a ativa; se não houver, a mais recente finalizada (vira a reativada).
  const { data: candidatas, error: errSel } = await sb
    .from("siso_inventario_operadores")
    .select("id, finalizado_em")
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .order("finalizado_em", { ascending: false, nullsFirst: true })
    .limit(1);
  if (errSel) throw errSel;
  const existente = (candidatas ?? [])[0] ?? null;

  const acao = decidirAcaoEntrada(existente);

  if (acao.tipo === "no-op") {
    return { retomado: false };
  }

  if (acao.tipo === "reativar") {
    const nowIso = new Date().toISOString();
    const { error } = await sb
      .from("siso_inventario_operadores")
      .update({
        finalizado_em: null,
        ultima_reentrada_em: nowIso,
        ultima_acao_em: nowIso,
      })
      .eq("id", acao.id);
    if (error) throw error;
    return { retomado: true };
  }

  // acao.tipo === "criar"
  const { error } = await sb.from("siso_inventario_operadores").insert({
    sessao_id: sessaoId,
    usuario_id: usuarioId,
  });
  if (error) {
    // 23505 = duplicate key (UNIQUE parcial em sessao+user ativo). Pode
    // acontecer em race condition rara entre maybeSingle e insert. Trata
    // como no-op (alguém já entrou pelo mesmo user concorrente).
    if (error.code === "23505") return { retomado: false };
    throw error;
  }
  return { retomado: false };
}

export async function sairParty(
  sessaoId: string,
  usuarioId: string,
): Promise<void> {
  const sb = createServiceClient();
  // [Fix-D #4.6] Libera locks de loc em_contagem desse operador SÍNCRONO ao
  // sair da party. Antes dependia do cleanup async (30min) — locks ficavam
  // órfãos bloqueando colegas durante a janela. RPC cleanup continua como
  // safety net pra casos de zumbi (operador some sem chamar sairParty).
  await sb
    .from("siso_inventario_localizacoes")
    .update({
      bloqueada_por: null,
      bloqueada_em: null,
      status: "pendente",
    })
    .eq("sessao_id", sessaoId)
    .eq("bloqueada_por", usuarioId)
    .eq("status", "em_contagem");

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
}

export type ClaimTipo = "rua" | "predio" | "colisao";
export type ClaimDirecao = "asc" | "desc";

export interface ProximaLocOutput {
  pool_vazio: boolean;
  inv_loc_id?: string;
  loc_id?: string;
  codigo?: string;
  tipo?: string;
  zona?: string;
  modo?: ModoContagem;
  esperados?: EsperadoItem[];
  /** Tipo do claim atribuído a este operador. 'rua' = exclusivo da rua,
   *  'predio' = só esse prédio, 'colisao' = compartilhando último prédio. */
  claim_tipo?: ClaimTipo;
  /** Código do claim ('A' pra rua, 'A-03' pra prédio/colisao). */
  claim_codigo?: string;
  /** Direção: 'asc' default, 'desc' quando entra em colisão pela ponta oposta. */
  claim_direcao?: ClaimDirecao;
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
    claim_tipo?: ClaimTipo;
    claim_codigo?: string;
    claim_direcao?: ClaimDirecao;
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
    claim_tipo: r.claim_tipo,
    claim_codigo: r.claim_codigo,
    claim_direcao: r.claim_direcao,
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
  qty_contada: number;
  contada_por: string;
  /**
   * - "incremental" (default): soma +qty na contagem deste operador na mesma tripla.
   * - "absoluto": substitui contagem prévia.
   */
  modo?: "incremental" | "absoluto";
}

/**
 * Registra um bipe de contagem na sessão de inventário.
 *
 * **Semântica de concorrência (2 ops na mesma tripla):**
 *
 * O modelo permite que múltiplos operadores bipem a mesma tripla
 * (produto × galpão × localização) na mesma sessão — caso edge documentado
 * desde o rewrite v2 (2026-05-12): se um operador faz `sairParty` mid-loc
 * antes de chamar `finalizarLoc`, a loc volta pro pool e outro op pode
 * pegá-la e bipar os mesmos SKUs.
 *
 * Como `computarDivergencias` consolida divergências, ele **soma todas as
 * contagens da tripla** (todas as linhas em `siso_inventario_contagens` com
 * mesmo `sessao_id + localizacao_id + produto_id`) — não importa quem
 * bipou. Resultado: se OP1 bipou 3 e OP2 bipou 2 na mesma tripla, a
 * `qty_contada_final` na divergência é 5.
 *
 * Isso é **intencional** pra casos legítimos (operadores cooperando numa
 * loc grande) e é a única opção segura quando o supervisor abre a tela de
 * divergências — não dá pra advinhar qual contagem é "a certa". A
 * divergência fica pendente se o total bater fora da tolerância.
 *
 * UNIQUE constraint na tabela é (sessao_id, localizacao_id, produto_id,
 * contada_por) — múltiplos ops podem ter rows separadas, mas o mesmo op
 * tem 1 row por tripla (a função abaixo trata incremental vs absoluto).
 */
export async function registrarContagem(
  input: RegistrarContagemInput,
): Promise<void> {
  const sb = createServiceClient();

  // [P058] Guard de status da SESSÃO (complementa o guard por-loc abaixo).
  // Se a sessão saiu de 'em_andamento' (foi pra revisao/aprovada/aplicada),
  // qualquer bipe novo cairia no vazio — bloqueia explicitamente. A sessão
  // contínua de contagem-inline fica permanentemente 'em_andamento', então
  // não é afetada.
  const { data: sessaoRow } = await sb
    .from("siso_inventario_sessoes")
    .select("status")
    .eq("id", input.sessao_id)
    .maybeSingle();
  if (!sessaoRow) {
    throw new Error("sessão não encontrada");
  }
  const sessaoStatus = (sessaoRow as { status: string }).status;
  if (sessaoStatus !== "em_andamento") {
    throw new Error(
      `sessão já saiu da fase em andamento (status ${sessaoStatus}) — supervisor cria nova para corrigir`,
    );
  }

  // P3 #4.3: bipe só é aceito se a loc está bloqueada por este operador.
  // Sem esse guard, qualquer usuário com sessão válida injetaria contagens
  // em sessões que nunca entrou (silent write vazamento).
  const { data: locRow } = await sb
    .from("siso_inventario_localizacoes")
    .select("bloqueada_por, status")
    .eq("sessao_id", input.sessao_id)
    .eq("localizacao_id", input.localizacao_id)
    .maybeSingle();
  if (!locRow) {
    throw new Error("localização não faz parte desta sessão");
  }
  const lr = locRow as { bloqueada_por: string | null; status: string };
  if (lr.status === "contada" || lr.status === "aprovada") {
    throw new Error(
      `loc já está em status ${lr.status} — re-abertura via supervisor`,
    );
  }
  if (!lr.bloqueada_por) {
    throw new Error(
      "loc não está reivindicada — chame /proxima-loc antes de bipar",
    );
  }
  if (lr.bloqueada_por !== input.contada_por) {
    throw new Error(
      `loc reivindicada por outro operador (${lr.bloqueada_por}). Aguarde liberação.`,
    );
  }

  // Se o produto bipado é um kit, expande pra contagens dos componentes
  // (qty_no_kit × qty_bipada por componente). Não registra contagem pro
  // próprio SKU do kit — kits não têm saldo direto em siso_estoque.
  const { data: prod } = await sb
    .from("siso_produtos")
    .select("eh_kit")
    .eq("id", input.produto_id)
    .maybeSingle();

  if (prod && (prod as { eh_kit?: boolean }).eh_kit) {
    const { data: comps } = await sb
      .from("siso_produto_kits")
      .select("componente_produto_id, quantidade")
      .eq("kit_produto_id", input.produto_id);
    if (!comps || comps.length === 0) {
      throw new Error(
        "SKU é um kit sem composição cadastrada — defina os componentes antes",
      );
    }
    for (const c of comps as Array<{
      componente_produto_id: string;
      quantidade: number;
    }>) {
      await registrarContagemSimples(sb, {
        ...input,
        produto_id: c.componente_produto_id,
        qty_contada: Number(c.quantidade) * input.qty_contada,
      });
    }
    return;
  }

  await registrarContagemSimples(sb, input);
}

async function registrarContagemSimples(
  sb: ReturnType<typeof createServiceClient>,
  input: RegistrarContagemInput,
): Promise<void> {
  const modo = input.modo ?? "incremental";

  const filtro = {
    sessao_id: input.sessao_id,
    localizacao_id: input.localizacao_id,
    produto_id: input.produto_id,
    contada_por: input.contada_por,
  };

  // Procura contagem prévia deste operador na mesma tripla
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

// P3 #4.5: lista de operadores ativos (sem `finalizado_em`) na sessão. Usada
// pelo gate em `computarDivergencias` (avisa antes de encerrar) e pode ser
// consumida pela UI pra mostrar "X operadores ativos" no botão de aprovar.
export async function listarOperadoresAtivos(
  sessao_id: string,
): Promise<Array<{ usuario_id: string; nome: string | null }>> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_inventario_operadores")
    .select("usuario_id, usuario:siso_usuarios(nome)")
    .eq("sessao_id", sessao_id)
    .is("finalizado_em", null);
  // Supabase tipa a relação FK como array; na prática vem 1 objeto (ou null).
  // Normaliza pra usar tanto array quanto objeto sem quebrar.
  const rows = (data ?? []) as unknown as Array<{
    usuario_id: string;
    usuario: { nome: string | null } | { nome: string | null }[] | null;
  }>;
  return rows.map((r) => {
    const u = Array.isArray(r.usuario) ? r.usuario[0] : r.usuario;
    return { usuario_id: r.usuario_id, nome: u?.nome ?? null };
  });
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ComputarDivergenciasOpts {
  parcial?: boolean;
  /**
   * P3 #4.5: opt-in pra fechar a sessão mesmo com operadores ativos.
   * Sem essa flag, a função aborta com Error code='OPERADORES_ATIVOS' e
   * anexa a lista pra UI mostrar quem ainda está dentro.
   */
  forceWithActiveOperators?: boolean;
}

/**
 * Recomputa divergências da sessão (compara contagens vs saldo reconciliado
 * via ledger temporalmente).
 *
 * LIMITAÇÃO CONHECIDA [#P6-4.8]: reconciliação temporal usa cutoff_em
 * (=contado_em). Movs entre cutoff_em e aprovado_em ainda alteram saldo
 * "esperado" no ledger, mas a divergência foi calculada com snapshot
 * cutoff_em. Pra reduzir janela: aprovar rapidamente após contagem.
 * Ver design doc:
 *   docs/superpowers/specs/2026-05-18-estoque-online-fluxo.html
 */
export async function computarDivergencias(
  sessaoId: string,
  opts: ComputarDivergenciasOpts = {},
): Promise<void> {
  const sb = createServiceClient();
  const parcial = opts.parcial === true;
  const cutoff_em = new Date().toISOString();

  // B4: Guard contra re-execução. Se sessão já foi computada (status >= revisao),
  // retornar no-op em vez de rodar cleanup de locks denovo (gera warning falso
  // + churn no ledger).
  const { data: sessaoGuard } = await sb
    .from("siso_inventario_sessoes")
    .select("status")
    .eq("id", sessaoId)
    .single();

  const statusAtual = (sessaoGuard as { status: string } | null)?.status;
  if (
    statusAtual === "revisao" ||
    statusAtual === "aprovada" ||
    statusAtual === "aplicada"
  ) {
    logger.info("computarDivergencias", "sessao já computada, no-op", {
      sessaoId,
      status: statusAtual,
    });
    return;
  }

  // P3 #4.5: aborta cedo se há operador ativo e o caller não confirmou.
  const ativos = await listarOperadoresAtivos(sessaoId);
  if (ativos.length > 0 && !opts.forceWithActiveOperators) {
    const err = new Error(
      `há ${ativos.length} operador(es) ativo(s) — passe forceWithActiveOperators=true se confirma`,
    ) as Error & { code?: string; operadores?: typeof ativos };
    err.code = "OPERADORES_ATIVOS";
    err.operadores = ativos;
    throw err;
  }

  // 1. Carrega locs da sessão (filtrando por modo parcial)
  const locsQuery = sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id, status, contagem_finalizada_em")
    .eq("sessao_id", sessaoId);

  const { data: locsSessao } = parcial
    ? await locsQuery.in("status", ["contada", "aprovada"])
    : await locsQuery;

  const locsRows = (locsSessao ?? []) as Array<{
    localizacao_id: string;
    status: string;
    contagem_finalizada_em: string | null;
  }>;

  // Em parcial sem locs → só fecha sessão
  if (parcial && locsRows.length === 0) {
    await sb
      .from("siso_inventario_sessoes")
      .update({ status: "revisao", finalizada_em: new Date().toISOString() })
      .eq("id", sessaoId);
    await sb
      .from("siso_inventario_operadores")
      .update({ finalizado_em: new Date().toISOString() })
      .eq("sessao_id", sessaoId)
      .is("finalizado_em", null);
    return;
  }

  const locIds = locsRows.map((l) => l.localizacao_id);
  const locsVisitadas = locsRows
    .filter((l) => l.contagem_finalizada_em !== null)
    .map((l) => ({
      localizacao_id: l.localizacao_id,
      contagem_finalizada_em: l.contagem_finalizada_em as string,
    }));

  // 2. Contagens (3D: produto + galpao + loc; sem empresa_dona)
  const { data: contagensRaw } = await sb
    .from("siso_inventario_contagens")
    .select("localizacao_id, produto_id, qty_contada, criado_em")
    .eq("sessao_id", sessaoId);

  const contagens = ((contagensRaw ?? []) as Array<{
    localizacao_id: string;
    produto_id: string;
    qty_contada: number;
    criado_em: string;
  }>).map((c) => ({
    localizacao_id: c.localizacao_id,
    produto_id: c.produto_id,
    qty_contada: Number(c.qty_contada),
    contado_em: c.criado_em,
  }));

  // 3. Saldos atuais (3D: produto + galpao + loc)
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

  const { data: saldosRaw } = await sb
    .from("siso_estoque")
    .select("produto_id, localizacao_id, saldo")
    .in("localizacao_id", locIds.length > 0 ? locIds : ["00000000-0000-0000-0000-000000000000"])
    .gt("saldo", 0);

  // Custo médio é global por produto (Fase 1 Task 1.x). Carrega só os produtos vistos.
  const produtosSaldo = ((saldosRaw ?? []) as Array<{ produto_id: string }>).map(
    (r) => r.produto_id,
  );
  const custoMap = new Map<string, number>();
  if (produtosSaldo.length > 0) {
    const { data: cmRaw } = await sb
      .from("siso_custo_medio")
      .select("produto_id, custo_medio")
      .in("produto_id", produtosSaldo);
    for (const r of (cmRaw ?? []) as Array<{ produto_id: string; custo_medio: number }>) {
      custoMap.set(r.produto_id, Number(r.custo_medio));
    }
  }

  const saldos_atuais = ((saldosRaw ?? []) as Array<{
    produto_id: string;
    localizacao_id: string;
    saldo: number;
  }>).map((r) => ({
    localizacao_id: r.localizacao_id,
    produto_id: r.produto_id,
    saldo: Number(r.saldo),
    custo_medio: custoMap.get(r.produto_id) ?? 0,
  }));

  // 4. Movs ledger nas locs da sessão, criadas após a contagem mais antiga
  //    e até cutoff. Reduz volume — não precisa varrer tudo.
  const minContado = contagens.length > 0
    ? contagens.map((c) => c.contado_em).sort()[0]
    : null;
  const dataLimiteInferior = janelaInferiorReconciliacao(minContado, cutoff_em); // [P059] início do dia; sem contagens → cutoff (query vazia)
  let movs: Array<{
    id: string;
    localizacao_id: string;
    produto_id: string;
    criado_em: string;
    saldo_anterior: number;
    saldo_posterior: number;
    origem_tipo: string;
    origem_id: string | null;
    estorno_de: string | null;
  }> = [];
  if (locIds.length > 0 && minContado) {
    const { data: movsRaw } = await sb
      .from("siso_movimentacoes")
      .select("id, localizacao_id, produto_id, criado_em, saldo_anterior, saldo_posterior, origem_tipo, origem_id, estorno_de")
      .in("localizacao_id", locIds)
      .gte("criado_em", dataLimiteInferior)
      .lte("criado_em", cutoff_em);
    movs = ((movsRaw ?? []) as typeof movs).map((m) => ({
      ...m,
      saldo_anterior: Number(m.saldo_anterior),
      saldo_posterior: Number(m.saldo_posterior),
    }));
  }

  // 5. Função pura
  const divergencias = reconciliarTemporal({
    sessao_id: sessaoId,
    cutoff_em,
    contagens,
    locs_visitadas: locsVisitadas,
    saldos_atuais,
    movs,
  });

  // 6. Persiste divergências aplicando tolerância
  // Primeiro, limpa divergências não-aplicadas pra essas triplas (re-run)
  for (const d of divergencias) {
    await sb
      .from("siso_inventario_divergencias")
      .delete()
      .match({
        sessao_id: sessaoId,
        localizacao_id: d.localizacao_id,
        produto_id: d.produto_id,
      })
      .neq("status", "aplicada");
  }

  for (const d of divergencias) {
    const delta_pct =
      d.saldo_esperado === 0 ? null : Math.abs((d.delta / d.saldo_esperado) * 100);
    const dentroTol =
      (s?.tolerancia_pct ?? 0) > 0 && delta_pct !== null
        ? delta_pct <= s!.tolerancia_pct
        : Math.abs(d.delta) <= (s?.tolerancia_qty_min ?? 0);
    const acimaValor =
      s?.exige_aprovacao_acima_valor != null &&
      Math.abs(d.valor_financeiro) > Number(s.exige_aprovacao_acima_valor);
    const status: "aprovada" | "pendente" =
      dentroTol && !acimaValor ? "aprovada" : "pendente";

    // .select() força supabase-js a expor erro PostgREST — sem isso, falha
    // silenciosa (ex.: ON CONFLICT sem constraint match → erro 42P10
    // descartado e 0 divergências persistidas). Bug histórico: sessão
    // be1c0fa8 (2026-05-20) gerou movs=0 porque o UNIQUE constraint sumiu
    // junto com empresa_dona_id em 20260520i — corrigido em 20260520j.
    const { error: upErr } = await sb
      .from("siso_inventario_divergencias")
      .upsert(
        {
          sessao_id: sessaoId,
          localizacao_id: d.localizacao_id,
          produto_id: d.produto_id,
          // NOTA: saldo_sistema agora guarda o saldo_esperado_no_bipe (reconciliação temporal) — nome mantido por compat
          saldo_sistema: d.saldo_esperado,
          qty_contada_final: d.qty_contada_final,
          valor_financeiro: d.valor_financeiro,
          status,
        },
        { onConflict: "sessao_id,localizacao_id,produto_id" },
      )
      .select("id");
    if (upErr) throw upErr;
  }

  // P3 #4.6: limpa locs órfãs em em_contagem cujo `bloqueada_por` não é
  // operador ativo (ex.: usuário saiu da party sem finalizar a loc).
  // Filtro defensivo via JS: valida UUIDs e exclui ativos.
  const ativosUserIds = ativos
    .map((a) => a.usuario_id)
    .filter((id) => UUID_RX.test(id));
  const { data: orfasRaw } = await sb
    .from("siso_inventario_localizacoes")
    .select("id, bloqueada_por")
    .eq("sessao_id", sessaoId)
    .eq("status", "em_contagem")
    .not("bloqueada_por", "is", null);
  const orfas = ((orfasRaw ?? []) as Array<{ id: string; bloqueada_por: string }>)
    .filter((r) => !ativosUserIds.includes(r.bloqueada_por));
  if (orfas.length > 0) {
    await sb
      .from("siso_inventario_localizacoes")
      .update({ status: "pendente", bloqueada_por: null, bloqueada_em: null })
      .in("id", orfas.map((o) => o.id));
  }

  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "revisao", finalizada_em: new Date().toISOString() })
    .eq("id", sessaoId);

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
  const { data: aprovadas } = await sb
    .from("siso_inventario_sessoes")
    .update({ status: "aprovada", aprovada_por: aprovadaPor })
    .eq("id", sessaoId)
    .eq("status", "revisao")
    .select("id");

  // Compare-and-set: 0 linhas → a sessão não estava em 'revisao' (já aprovada
  // por outra chamada concorrente, ou nunca finalizada). No-op idempotente:
  // não reaplica nem dispara efeitos colaterais (liberação de locks).
  if (!aprovadas || aprovadas.length === 0) {
    const { data: atual } = await sb
      .from("siso_inventario_sessoes")
      .select("status")
      .eq("id", sessaoId)
      .single();
    throw new Error(
      `sessão não está em revisão (status atual: ${(atual as { status: string } | null)?.status ?? "?"}) — não pode ser aprovada`,
    );
  }

  // Libera locks externos SÓ quando a aprovação efetivamente transicionou.
  // Aplicação (gerar movs) é só ato contábil — não precisa segurar lock
  // contra outras sessões.
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
  const { data, error } = await sb.rpc("wms_aplicar_sessao_inventario", {
    p_sessao: sessaoId,
    p_usuario: usuarioId,
  });
  if (error) throw error;
  return { movsGeradas: Number((data as { movs_geradas: number }).movs_geradas) };
}

// Alias retrocompat — alguns callers ainda importam o nome antigo.
export const criarSessaoInventario = criarSessao;

// ─────────────────────────────────────────────────────────────────────
// Últimas contagens por produto — feed pra aba "Movimentações" do produto
// Mostra "quando esse produto foi conferido pela última vez em cada loc"
// mesmo quando a contagem não gerou divergência (e portanto não há mov
// no ledger). Pula sessões canceladas.
// ─────────────────────────────────────────────────────────────────────

export interface UltimaContagemProduto {
  localizacao_id: string;
  loc_codigo: string;
  loc_tipo: string;
  galpao_id: string;
  galpao_nome: string;
  qty_contada: number;
  contada_por: string;
  contada_por_nome: string | null;
  contada_em: string;
  sessao_id: string;
  sessao_nome: string | null;
  sessao_status: StatusSessao;
  saldo_atual: number;
}

export async function ultimasContagensDoProduto(
  produtoId: string,
): Promise<UltimaContagemProduto[]> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_produto_ultimas_contagens", {
    p_produto_id: produtoId,
  });
  if (error) throw error;
  return (data ?? []) as UltimaContagemProduto[];
}

// ─────────────────────────────────────────────────────────────────────
// P3 #4.2 — Estornar sessão de inventário aplicada
// ─────────────────────────────────────────────────────────────────────

/**
 * Estorna uma sessão de inventário aplicada — tudo-ou-nada via RPC
 * wms_estornar_sessao_inventario (P056/P061).
 *
 * A RPC faz preflight de saldo de TODAS as contra-movs antes de inserir
 * qualquer uma: se um estorno deixaria saldo negativo (alguém consumiu),
 * RAISE nomeando o produto → rollback total (nenhum estorno parcial). Só
 * se todas passam: insere contra-movs (origem 'estorno'), reseta cada
 * divergência pra 'pendente' e a sessão pra 'revisao' (aplicada_em=NULL).
 *
 * Idempotente: sessão != 'aplicada' → no-op (movs_estornadas=0).
 */
export async function estornarSessaoInventario(input: {
  sessao_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movsEstornadas: number }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do estorno é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_estornar_sessao_inventario", {
    p_sessao: input.sessao_id,
    p_usuario: input.usuario_id,
    p_motivo: input.motivo,
  });
  if (error) {
    throw new Error(error.message);
  }
  return { movsEstornadas: (data as { movs_estornadas: number }).movs_estornadas };
}

/**
 * [P159] Estorna UMA divergência aplicada (não a sessão inteira). Reseta a
 * divergência alvo pra 'pendente' e não toca nas demais. Reusa o guard de
 * double-estorno de estornarMovimentacao. Não força a sessão a recontagem das
 * que continuam corretas; se ainda restarem 'aplicada', a sessão segue 'aplicada'.
 */
export async function estornarDivergenciaInventario(input: {
  divergencia_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movEstornada: boolean }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do estorno é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const { data: div } = await sb
    .from("siso_inventario_divergencias")
    .select("id, sessao_id, mov_aplicada_id, status")
    .eq("id", input.divergencia_id)
    .maybeSingle();
  if (!div) throw new Error("divergência não encontrada");
  const d = div as { id: string; sessao_id: string; mov_aplicada_id: string | null; status: string };
  if (d.status !== "aplicada") {
    throw new Error(`divergência em status ${d.status} — apenas 'aplicada' pode ser estornada`);
  }
  let estornada = false;
  if (d.mov_aplicada_id) {
    try {
      await estornarMovimentacao({
        mov_id: d.mov_aplicada_id,
        usuario_id: input.usuario_id,
        motivo: `Estorno divergência ${d.id}: ${input.motivo}`,
      });
      estornada = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/já foi estornada|já é um estorno/.test(msg)) throw err;
    }
  }
  const { error: updErr } = await sb
    .from("siso_inventario_divergencias")
    .update({ status: "pendente", mov_aplicada_id: null })
    .eq("id", d.id);
  if (updErr) {
    throw new Error(`falha ao resetar divergência ${d.id}: ${updErr.message}`);
  }
  return { movEstornada: estornada };
}

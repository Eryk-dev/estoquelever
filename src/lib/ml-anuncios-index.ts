import type { SupabaseClient } from "@supabase/supabase-js";
import {
  collectAllSkusFromItem,
  getMlActiveItemsDetailsForScan,
  scanSellerActiveItemsPage,
  type MlItem,
  type MlSellerItemsScanPage,
} from "./ml-api";
import {
  listarConexoesMlAtivas,
  normalizarSkuAnuncio,
  type ConexaoMlAtiva,
} from "./ml-anuncios";
import { logger } from "./logger";
import { createServiceClient } from "./supabase-server";

export const INDICE_ML_MAX_AGE_MS = 30 * 60 * 60_000;
const SCAN_REFRESH_MS = 20 * 60 * 60_000;
const SCROLL_MAX_IDLE_MS = 4 * 60_000;
const LEASE_MS = 4 * 60_000;

interface ScanState {
  conexao_id: string;
  status: "idle" | "scanning" | "completed" | "error";
  scan_generation: string | null;
  scroll_id: string | null;
  scroll_tocado_em: string | null;
  busca_em_andamento: boolean;
  pagina_pendente_ids: string[] | null;
  pagina_pendente_final: boolean;
  paginas_processadas: number;
  itens_processados: number;
  iniciado_em: string | null;
  ultima_geracao_concluida: string | null;
  ultima_varredura_completa_em: string | null;
  ultimo_total_itens: number | null;
  ultimo_erro: string | null;
  lease_token: string | null;
  lease_ate: string | null;
  atualizado_em: string;
}

export interface LinhaIndiceMl {
  conexao_id: string;
  scan_generation: string;
  sku_normalizado: string;
  sku_original: string;
  mlb_id: string;
}

export interface ContaIndiceMl {
  conexao_id: string;
  nickname: string;
  status: "sem_scan" | ScanState["status"];
  varredura_completa_em: string | null;
  itens_indexados: number | null;
}

export interface IndiceCompletoAnunciosAtivos {
  schemaDisponivel: boolean;
  coberturaCompleta: boolean;
  skusAtivos: Set<string>;
  anunciosAtivos: number;
  contasAtivas: number;
  contasComSnapshot: number;
  atualizadoEm: string | null;
  snapshotMaisAntigoEm: string | null;
  validoAte: string | null;
  contas: ContaIndiceMl[];
}

export function extrairLinhasIndiceMl(
  conexaoId: string,
  scanGeneration: string,
  items: MlItem[],
): LinhaIndiceMl[] {
  const unicos = new Map<string, LinhaIndiceMl>();
  for (const item of items) {
    if (item.status !== "active") continue;
    for (const skuOriginal of collectAllSkusFromItem(item)) {
      const skuNormalizado = normalizarSkuAnuncio(skuOriginal);
      if (!skuNormalizado) continue;
      const key = `${skuNormalizado}\u0000${item.id}`;
      if (!unicos.has(key)) {
        unicos.set(key, {
          conexao_id: conexaoId,
          scan_generation: scanGeneration,
          sku_normalizado: skuNormalizado,
          sku_original: skuOriginal.trim(),
          mlb_id: item.id,
        });
      }
    }
  }
  return Array.from(unicos.values());
}

export function coberturaIndiceEstaCompleta(
  conexoes: Array<{ id: string }>,
  states: Array<
    Pick<
      ScanState,
      | "conexao_id"
      | "ultima_geracao_concluida"
      | "ultima_varredura_completa_em"
    >
  >,
  nowMs = Date.now(),
  maxAgeMs = INDICE_ML_MAX_AGE_MS,
): boolean {
  if (conexoes.length === 0) return false;
  const porConexao = new Map(states.map((state) => [state.conexao_id, state]));
  return conexoes.every((conexao) => {
    const state = porConexao.get(conexao.id);
    if (
      !state?.ultima_geracao_concluida ||
      !state.ultima_varredura_completa_em
    ) {
      return false;
    }
    const completedMs = Date.parse(state.ultima_varredura_completa_em);
    return (
      Number.isFinite(completedMs) &&
      completedMs <= nowMs &&
      nowMs - completedMs <= maxAgeMs
    );
  });
}

function schemaAindaNaoAplicado(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.message?.includes("siso_ml_anuncios_scan_state") === true ||
    error.message?.includes("siso_ml_anuncios_indice_completo") === true
  );
}

function indiceIndisponivel(
  conexoes: ConexaoMlAtiva[],
): IndiceCompletoAnunciosAtivos {
  return {
    schemaDisponivel: false,
    coberturaCompleta: false,
    skusAtivos: new Set(),
    anunciosAtivos: 0,
    contasAtivas: conexoes.length,
    contasComSnapshot: 0,
    atualizadoEm: null,
    snapshotMaisAntigoEm: null,
    validoAte: null,
    contas: conexoes.map((conexao) => ({
      conexao_id: conexao.id,
      nickname: conexao.nickname,
      status: "sem_scan",
      varredura_completa_em: null,
      itens_indexados: null,
    })),
  };
}

export async function getIndiceCompletoAnunciosAtivos(): Promise<IndiceCompletoAnunciosAtivos> {
  const conexoes = await listarConexoesMlAtivas();
  if (conexoes.length === 0) return indiceIndisponivel(conexoes);

  const supabase = createServiceClient();
  const { data: stateData, error: stateError } = await supabase
    .from("siso_ml_anuncios_scan_state")
    .select(
      "conexao_id, status, ultima_geracao_concluida, ultima_varredura_completa_em, ultimo_total_itens",
    )
    .in(
      "conexao_id",
      conexoes.map((conexao) => conexao.id),
    );
  if (stateError) {
    if (schemaAindaNaoAplicado(stateError)) {
      logger.warn("ml-anuncios-index", "Migration do índice ainda não aplicada", {
        code: stateError.code,
      });
      return indiceIndisponivel(conexoes);
    }
    throw stateError;
  }

  const states = (stateData ?? []) as Array<
    Pick<
      ScanState,
      | "conexao_id"
      | "status"
      | "ultima_geracao_concluida"
      | "ultima_varredura_completa_em"
      | "ultimo_total_itens"
    >
  >;
  const statePorConexao = new Map(
    states.map((state) => [state.conexao_id, state]),
  );
  const statesComSnapshot = states.filter(
    (state) =>
      state.ultima_geracao_concluida &&
      state.ultima_varredura_completa_em,
  );
  const skusAtivos = new Set<string>();
  const anuncios = new Set<string>();

  if (statesComSnapshot.length > 0) {
    const filtroGeracoes = statesComSnapshot
      .map(
        (state) =>
          `and(conexao_id.eq.${state.conexao_id},scan_generation.eq.${state.ultima_geracao_concluida})`,
      )
      .join(",");
    const PAGE_SIZE = 1000;
    for (let page = 0; ; page++) {
      const { data, error } = await supabase
        .from("siso_ml_anuncios_indice_completo")
        .select("conexao_id, scan_generation, sku_normalizado, mlb_id")
        .or(filtroGeracoes)
        .order("conexao_id", { ascending: true })
        .order("scan_generation", { ascending: true })
        .order("sku_normalizado", { ascending: true })
        .order("mlb_id", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) {
        if (schemaAindaNaoAplicado(error)) return indiceIndisponivel(conexoes);
        throw error;
      }
      const rows = data ?? [];
      for (const row of rows) {
        const state = statePorConexao.get(row.conexao_id);
        if (state?.ultima_geracao_concluida !== row.scan_generation) continue;
        skusAtivos.add(row.sku_normalizado);
        anuncios.add(`${row.conexao_id}\u0000${row.mlb_id}`);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }

  const datas = statesComSnapshot
    .map((state) => state.ultima_varredura_completa_em!)
    .sort();
  const snapshotMaisAntigoEm = datas[0] ?? null;
  const atualizadoEm = datas.at(-1) ?? null;
  const validoAte = snapshotMaisAntigoEm
    ? new Date(
        Date.parse(snapshotMaisAntigoEm) + INDICE_ML_MAX_AGE_MS,
      ).toISOString()
    : null;

  return {
    schemaDisponivel: true,
    coberturaCompleta: coberturaIndiceEstaCompleta(conexoes, states),
    skusAtivos,
    anunciosAtivos: anuncios.size,
    contasAtivas: conexoes.length,
    contasComSnapshot: statesComSnapshot.length,
    atualizadoEm,
    snapshotMaisAntigoEm,
    validoAte,
    contas: conexoes.map((conexao) => {
      const state = statePorConexao.get(conexao.id);
      return {
        conexao_id: conexao.id,
        nickname: conexao.nickname,
        status: state?.status ?? "sem_scan",
        varredura_completa_em:
          state?.ultima_varredura_completa_em ?? null,
        itens_indexados: state?.ultimo_total_itens ?? null,
      };
    }),
  };
}

async function garantirEstado(
  supabase: SupabaseClient,
  conexaoId: string,
): Promise<ScanState> {
  const { error: insertError } = await supabase
    .from("siso_ml_anuncios_scan_state")
    .upsert(
      { conexao_id: conexaoId, status: "idle" },
      { onConflict: "conexao_id", ignoreDuplicates: true },
    );
  if (insertError) throw insertError;
  const { data, error } = await supabase
    .from("siso_ml_anuncios_scan_state")
    .select("*")
    .eq("conexao_id", conexaoId)
    .single();
  if (error) throw error;
  return data as ScanState;
}

async function adquirirLease(
  supabase: SupabaseClient,
  state: ScanState,
): Promise<{ state: ScanState; token: string } | null> {
  const now = Date.now();
  if (state.lease_ate && Date.parse(state.lease_ate) > now) return null;

  const token = crypto.randomUUID();
  let query = supabase
    .from("siso_ml_anuncios_scan_state")
    .update({
      lease_token: token,
      lease_ate: new Date(now + LEASE_MS).toISOString(),
      atualizado_em: new Date(now).toISOString(),
    })
    .eq("conexao_id", state.conexao_id);
  query = state.lease_token
    ? query.eq("lease_token", state.lease_token)
    : query.is("lease_token", null);
  query = state.lease_ate
    ? query.eq("lease_ate", state.lease_ate)
    : query.is("lease_ate", null);

  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw error;
  return data ? { state: data as ScanState, token } : null;
}

async function atualizarComLease(
  supabase: SupabaseClient,
  state: ScanState,
  token: string,
  patch: Record<string, unknown>,
): Promise<ScanState> {
  const now = Date.now();
  const { data, error } = await supabase
    .from("siso_ml_anuncios_scan_state")
    .update({
      ...patch,
      lease_ate: new Date(now + LEASE_MS).toISOString(),
      atualizado_em: new Date(now).toISOString(),
    })
    .eq("conexao_id", state.conexao_id)
    .eq("lease_token", token)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Lease perdido na conexão ${state.conexao_id}`);
  return data as ScanState;
}

async function liberarLease(
  supabase: SupabaseClient,
  conexaoId: string,
  token: string,
) {
  const { error } = await supabase
    .from("siso_ml_anuncios_scan_state")
    .update({
      lease_token: null,
      lease_ate: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("conexao_id", conexaoId)
    .eq("lease_token", token);
  if (error) {
    logger.warn("ml-anuncios-index", "Falha ao liberar lease", {
      conexaoId,
      error: error.message,
    });
  }
}

async function limparGeracoesDescartadas(
  supabase: SupabaseClient,
  state: ScanState,
  manterGeracao?: string,
) {
  let query = supabase
    .from("siso_ml_anuncios_indice_completo")
    .delete()
    .eq("conexao_id", state.conexao_id);
  if (manterGeracao) query = query.neq("scan_generation", manterGeracao);
  const { error } = await query;
  if (error) {
    logger.warn("ml-anuncios-index", "Falha ao limpar geração descartada", {
      conexaoId: state.conexao_id,
      error: error.message,
    });
  }
}

async function iniciarNovaGeracao(
  supabase: SupabaseClient,
  state: ScanState,
  token: string,
): Promise<ScanState> {
  const geracaoAnterior = state.scan_generation;
  const novaGeracao = crypto.randomUUID();
  const next = await atualizarComLease(supabase, state, token, {
    status: "scanning",
    scan_generation: novaGeracao,
    scroll_id: null,
    scroll_tocado_em: null,
    busca_em_andamento: false,
    pagina_pendente_ids: null,
    pagina_pendente_final: false,
    paginas_processadas: 0,
    itens_processados: 0,
    iniciado_em: new Date().toISOString(),
    ultimo_erro: null,
  });
  if (
    geracaoAnterior &&
    geracaoAnterior !== state.ultima_geracao_concluida
  ) {
    const { error } = await supabase
      .from("siso_ml_anuncios_indice_completo")
      .delete()
      .eq("conexao_id", state.conexao_id)
      .eq("scan_generation", geracaoAnterior);
    if (error) {
      logger.warn("ml-anuncios-index", "Falha ao limpar draft abandonado", {
        conexaoId: state.conexao_id,
        error: error.message,
      });
    }
  }
  return next;
}

function snapshotPrecisaAtualizar(state: ScanState, now = Date.now()) {
  if (!state.ultima_varredura_completa_em) return true;
  const completed = Date.parse(state.ultima_varredura_completa_em);
  return !Number.isFinite(completed) || now - completed >= SCAN_REFRESH_MS;
}

/**
 * O contrato do scan encerra somente quando a página de resultados vem vazia.
 * `paging.total` é informativo e pode mudar durante uma varredura; usá-lo para
 * publicar uma geração antecipadamente poderia produzir uma ausência falsa.
 */
export function paginaScanEhFinal(
  page: Pick<MlSellerItemsScanPage, "results" | "scroll_id">,
): boolean {
  if (page.results.length > 0 && !page.scroll_id) {
    throw new Error(
      "ML scan devolveu resultados sem scroll_id; geração não será publicada",
    );
  }
  return page.results.length === 0;
}

export function erroPermiteRetomarCheckpoint(
  state: Pick<ScanState, "pagina_pendente_ids" | "busca_em_andamento">,
  message: string,
): boolean {
  // A página já foi persistida antes do multi-get/upsert, então repetir é
  // idempotente. No fetch do scroll só retomamos 429: a API recusou a chamada
  // antes de entregar/avançar uma página. Outros erros reiniciam a geração.
  return (
    state.pagina_pendente_ids !== null ||
    (state.busca_em_andamento && /\bML API 429\b/.test(message))
  );
}

async function processarPaginaPendente(
  supabase: SupabaseClient,
  conexao: ConexaoMlAtiva,
  state: ScanState,
  token: string,
) {
  if (!state.scan_generation || state.pagina_pendente_ids === null) {
    throw new Error("Checkpoint de página incompleto");
  }

  const { items, skipped } = await getMlActiveItemsDetailsForScan(
    conexao.id,
    state.pagina_pendente_ids,
  );
  if (skipped.length > 0) {
    logger.info(
      "ml-anuncios-index",
      "Anúncios deixaram de estar ativos durante o scan",
      {
        conexaoId: conexao.id,
        quantidade: skipped.length,
      },
    );
  }
  const linhas = extrairLinhasIndiceMl(
    conexao.id,
    state.scan_generation,
    items,
  );
  if (linhas.length > 0) {
    const { error } = await supabase
      .from("siso_ml_anuncios_indice_completo")
      .upsert(linhas, {
        onConflict:
          "conexao_id,scan_generation,sku_normalizado,mlb_id",
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }

  const paginasProcessadas = state.paginas_processadas + 1;
  const itensProcessados =
    state.itens_processados + state.pagina_pendente_ids.length;
  if (state.pagina_pendente_final) {
    const completed = await atualizarComLease(supabase, state, token, {
      status: "completed",
      busca_em_andamento: false,
      pagina_pendente_ids: null,
      pagina_pendente_final: false,
      scroll_id: null,
      scroll_tocado_em: null,
      paginas_processadas: paginasProcessadas,
      itens_processados: itensProcessados,
      ultima_geracao_concluida: state.scan_generation,
      ultima_varredura_completa_em: new Date().toISOString(),
      ultimo_total_itens: itensProcessados,
      ultimo_erro: null,
    });
    await limparGeracoesDescartadas(
      supabase,
      completed,
      state.scan_generation,
    );
    return { status: "completed" as const, itens: itensProcessados };
  }

  await atualizarComLease(supabase, state, token, {
    status: "scanning",
    pagina_pendente_ids: null,
    pagina_pendente_final: false,
    paginas_processadas: paginasProcessadas,
    itens_processados: itensProcessados,
    ultimo_erro: null,
  });
  return { status: "page_processed" as const, itens: itensProcessados };
}

async function processarConexao(
  supabase: SupabaseClient,
  conexao: ConexaoMlAtiva,
) {
  const inicial = await garantirEstado(supabase, conexao.id);
  const lease = await adquirirLease(supabase, inicial);
  if (!lease) return { conexao_id: conexao.id, status: "leased" as const };

  let state = lease.state;
  const token = lease.token;
  try {
    if (
      state.status === "completed" &&
      !snapshotPrecisaAtualizar(state)
    ) {
      return { conexao_id: conexao.id, status: "fresh" as const };
    }

    const scrollExpirou =
      state.scroll_id !== null &&
      (!state.scroll_tocado_em ||
        Date.now() - Date.parse(state.scroll_tocado_em) >
          SCROLL_MAX_IDLE_MS);
    const precisaReiniciar =
      !state.scan_generation ||
      state.status === "error" ||
      state.status === "completed" ||
      state.busca_em_andamento ||
      (state.pagina_pendente_ids === null && scrollExpirou);
    if (precisaReiniciar) {
      state = await iniciarNovaGeracao(supabase, state, token);
    }

    if (state.pagina_pendente_ids !== null) {
      const result = await processarPaginaPendente(
        supabase,
        conexao,
        state,
        token,
      );
      return { conexao_id: conexao.id, ...result };
    }

    state = await atualizarComLease(supabase, state, token, {
      busca_em_andamento: true,
      ultimo_erro: null,
    });
    const page = await scanSellerActiveItemsPage(
      conexao.id,
      conexao.ml_user_id,
      state.scroll_id,
    );
    const paginaFinal = paginaScanEhFinal(page);
    state = await atualizarComLease(supabase, state, token, {
      busca_em_andamento: false,
      pagina_pendente_ids: page.results,
      pagina_pendente_final: paginaFinal,
      scroll_id: page.scroll_id,
      scroll_tocado_em: new Date().toISOString(),
    });
    const result = await processarPaginaPendente(
      supabase,
      conexao,
      state,
      token,
    );
    return { conexao_id: conexao.id, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const podeRetomar = erroPermiteRetomarCheckpoint(state, message);
    try {
      await atualizarComLease(supabase, state, token, {
        status: podeRetomar ? "scanning" : "error",
        ...(podeRetomar ? { busca_em_andamento: false } : {}),
        ultimo_erro: message.slice(0, 1000),
      });
    } catch {
      // Se nem o erro pôde ser gravado, o checkpoint anterior continua
      // conservador: busca_em_andamento=true reinicia a geração após fetch.
    }
    logger.error("ml-anuncios-index", "Falha ao processar conta", {
      conexaoId: conexao.id,
      error: message,
      checkpointPreservado: podeRetomar,
    });
    return {
      conexao_id: conexao.id,
      status: podeRetomar
        ? ("retry_scheduled" as const)
        : ("error" as const),
      error: message,
    };
  } finally {
    await liberarLease(supabase, conexao.id, token);
  }
}

export async function processarFatiaIndiceMl() {
  const conexoes = await listarConexoesMlAtivas();
  const supabase = createServiceClient();
  const resultados: Awaited<ReturnType<typeof processarConexao>>[] =
    new Array(conexoes.length);
  let proxima = 0;
  // As contas compartilham o rate limit do Client ID. Duas filas evitam o pico
  // de todas as contas juntas sem transformar a latência acumulada em timeout
  // do worker HTTP quando houver várias conexões.
  const worker = async () => {
    while (proxima < conexoes.length) {
      const index = proxima++;
      resultados[index] = await processarConexao(
        supabase,
        conexoes[index],
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, conexoes.length) }, () => worker()),
  );
  return {
    contas_ativas: conexoes.length,
    processadas: resultados.filter(
      (resultado) =>
        resultado.status === "page_processed" ||
        resultado.status === "completed",
    ).length,
    concluidas: resultados.filter(
      (resultado) => resultado.status === "completed",
    ).length,
    erros: resultados.filter((resultado) => resultado.status === "error")
      .length,
    retentativas: resultados.filter(
      (resultado) => resultado.status === "retry_scheduled",
    ).length,
    resultados,
  };
}

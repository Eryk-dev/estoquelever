// Lógica de put-away (etapa de Guarda).
//
// Cada linha de recebimento gera 1 pendência em siso_wms_pendencias_guarda.
// O operador no tablet pega da fila, imprime etiquetas, transporta as peças
// até a loc destino, bipa o QR da loc, e confirma — esse confirmar dispara
// uma mov par S+E (replenishment intra-galpão) saindo da loc RECEBIMENTO
// e entrando na loc final.
//
// Em 3D, o par S+E é NEUTRO (sem empresa) — a empresa que comprou viajou
// na mov de entrada como tag (`empresa_compradora_id`), e o put-away
// apenas reposiciona o saldo dentro do pool físico do galpão.
//
// Guarda parcial é suportada: se a pendência tem qty_pendente=5 e o operador
// guarda só 3, a pendência fica com qty_pendente=2 (status volta pra pendente)
// e a próxima operação zera o restante.

import { createServiceClient } from "@/lib/supabase-server";
import { estornarMovimentacao } from "./ledger";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "wms.guarda";

export type StatusPendencia = "pendente" | "em_guarda" | "guardada" | "cancelada";

export interface PendenciaGuarda {
  id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_origem_id: string;
  /**
   * Loc destino decidida pelo operador do recebimento (opcional).
   * Quando NULL, o tablet usa sugestão dinâmica de putaway.
   * Não força a guarda — operador pode bipa outra loc pra trocar.
   */
  localizacao_destino_id: string | null;
  /**
   * UUID compartilhado entre pendências do mesmo recebimento.
   * Frontend usa pra agrupar a fila em rotas (1 lote = 1 caminhada).
   * NULL em pendências avulsas (pré-feature ou casos edge).
   */
  lote_id: string | null;
  mov_entrada_id: string;
  nf_referencia: string | null;
  origem_tipo: string;
  custo_unitario: number | null;
  qty_inicial: number;
  qty_guardada: number;
  qty_pendente: number;
  status: StatusPendencia;
  iniciada_em: string | null;
  iniciada_por: string | null;
  guardada_em: string | null;
  guardada_por: string | null;
  cancelada_em: string | null;
  cancelada_por: string | null;
  motivo_cancelamento: string | null;
  observacoes: string | null;
  criada_em: string;
  criada_por: string | null;
  atualizada_em: string;
}

export interface PendenciaJoined extends PendenciaGuarda {
  produto: { sku: string; descricao: string; imagem_url: string | null } | null;
  galpao: { nome: string } | null;
  localizacao_origem: { codigo: string } | null;
  localizacao_destino: { codigo: string; tipo: string } | null;
}

/**
 * Resolve (ou cria) a loc tipo='recebimento' do galpão. Idempotente.
 * Migration já cria 1 por galpão ativo, mas em testes/staging pode faltar.
 *
 * Retorna `{ id, created }` — `created=true` indica que a loc foi auto-criada
 * agora (side-effect). Callers podem logar warning pra alertar que a
 * pré-condição esperada (loc semeada via migration) está faltando.
 */
export async function resolverLocRecebimento(
  galpaoId: string,
): Promise<{ id: string; created: boolean }> {
  const sb = createServiceClient();
  const { data: existente } = await sb
    .from("siso_localizacoes")
    .select("id")
    .match({ galpao_id: galpaoId, tipo: "recebimento", ativo: true })
    .order("criado_em", { ascending: true })
    .limit(1);
  if (existente && existente.length > 0) {
    return { id: existente[0].id, created: false };
  }

  const { data: nova, error } = await sb
    .from("siso_localizacoes")
    .insert({
      galpao_id: galpaoId,
      codigo: "RECEBIMENTO",
      descricao: "Área de chegada (auto-criada)",
      tipo: "recebimento",
      ativo: true,
    })
    .select("id")
    .single();
  if (error || !nova) {
    throw new Error(
      `não foi possível resolver loc RECEBIMENTO do galpão ${galpaoId}: ${error?.message}`,
    );
  }
  return { id: nova.id, created: true };
}

export interface CriarPendenciaInput {
  produto_id: string;
  galpao_id: string;
  localizacao_origem_id: string;
  /**
   * Loc destino opcional decidida no recebimento. Valida que pertence ao
   * mesmo galpão e é diferente da origem. Se NULL, o tablet decide depois.
   */
  localizacao_destino_id?: string | null;
  mov_entrada_id: string;
  qty_inicial: number;
  origem_tipo: string;
  nf_referencia?: string | null;
  custo_unitario?: number | null;
  observacoes?: string | null;
  /** UUID compartilhado entre pendências do mesmo recebimento (agrupamento de rota). */
  lote_id?: string | null;
  /** Usuário que criou a pendência (operador do recebimento). FK pra `siso_usuarios.id`. */
  criada_por: string;
}

export async function criarPendencia(input: CriarPendenciaInput): Promise<string> {
  const sb = createServiceClient();
  // Valida loc destino (se passada). Erro aqui aborta a criação da pendência
  // — recebedor recebe 400 e arruma a escolha antes de confirmar de novo.
  if (input.localizacao_destino_id) {
    if (input.localizacao_destino_id === input.localizacao_origem_id) {
      throw new Error("loc destino não pode ser igual à loc de recebimento");
    }
    const { data: locDest } = await sb
      .from("siso_localizacoes")
      .select("id, galpao_id, ativo")
      .eq("id", input.localizacao_destino_id)
      .maybeSingle();
    if (!locDest) throw new Error("localização destino não encontrada");
    if (!locDest.ativo) throw new Error("localização destino inativa");
    if (locDest.galpao_id !== input.galpao_id) {
      throw new Error("localização destino é de outro galpão");
    }
  }
  const { data, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .insert({
      produto_id: input.produto_id,
      galpao_id: input.galpao_id,
      localizacao_origem_id: input.localizacao_origem_id,
      localizacao_destino_id: input.localizacao_destino_id ?? null,
      mov_entrada_id: input.mov_entrada_id,
      qty_inicial: input.qty_inicial,
      origem_tipo: input.origem_tipo,
      nf_referencia: input.nf_referencia ?? null,
      custo_unitario: input.custo_unitario ?? null,
      observacoes: input.observacoes ?? null,
      lote_id: input.lote_id ?? null,
      criada_por: input.criada_por,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`falha ao criar pendência de guarda: ${error?.message}`);
  }
  return data.id;
}

export interface ListarPendenciasFiltros {
  galpao_id?: string;
  status?: StatusPendencia[];
  q?: string;
  limit?: number;
}

export async function listarPendencias(
  filtros: ListarPendenciasFiltros = {},
): Promise<PendenciaJoined[]> {
  const sb = createServiceClient();
  const statusFiltro = filtros.status ?? ["pendente", "em_guarda"];
  let query = sb
    .from("siso_wms_pendencias_guarda")
    .select(
      `
        *,
        produto:siso_produtos(sku, descricao, imagem_url),
        galpao:siso_galpoes(nome),
        localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
        localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo, tipo)
`,
    )
    .in("status", statusFiltro)
    .order("criada_em", { ascending: true })
    .limit(filtros.limit ?? 200);
  if (filtros.galpao_id) query = query.eq("galpao_id", filtros.galpao_id);

  const { data, error } = await query;
  if (error) throw error;

  let rows = ((data ?? []) as unknown as PendenciaJoined[]).map(normalizarNumeros);
  if (filtros.q) {
    const q = filtros.q.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.produto?.sku.toLowerCase().includes(q) ||
        r.produto?.descricao.toLowerCase().includes(q),
    );
  }
  return rows;
}

/**
 * Lista pendências de uma rota (lote, ids ad-hoc, ou todas do galpão).
 *
 * Ordena por loc destino (codigo asc, NULL no fim — pendências sem loc
 * decidida no recebimento). Pendências em status terminal são filtradas.
 *
 * - `lote_id`: pega tudo do lote
 * - `pendencia_ids`: pega só esses (rota ad-hoc / "guardar tudo" com sub-seleção)
 * - `galpao_id + todas=true`: pega tudo do galpão ativo (botão "Guardar tudo")
 *
 * Mutex de filtros: ao menos um precisa ser informado.
 */
export async function listarRotaPendencias(input: {
  lote_id?: string;
  pendencia_ids?: string[];
  galpao_id?: string;
  todas?: boolean;
}): Promise<PendenciaJoined[]> {
  const { lote_id, pendencia_ids, galpao_id, todas } = input;
  if (!lote_id && !pendencia_ids?.length && !todas) {
    throw new Error("informe lote_id, pendencia_ids, ou todas=true");
  }

  const sb = createServiceClient();
  let q = sb
    .from("siso_wms_pendencias_guarda")
    .select(
      `
        *,
        produto:siso_produtos(sku, descricao, imagem_url),
        galpao:siso_galpoes(nome),
        localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
        localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo, tipo)
      `,
    )
    .in("status", ["pendente", "em_guarda"]);

  if (lote_id) q = q.eq("lote_id", lote_id);
  if (pendencia_ids?.length) q = q.in("id", pendencia_ids);
  if (galpao_id) q = q.eq("galpao_id", galpao_id);

  const { data, error } = await q.limit(500);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as PendenciaJoined[]).map(
    normalizarNumeros,
  );

  // Ordena: por codigo da loc destino asc, NULL no fim, depois criada_em asc
  // pra estabilidade entre pendências sem loc decidida.
  rows.sort((a, b) => {
    const aCod = a.localizacao_destino?.codigo ?? null;
    const bCod = b.localizacao_destino?.codigo ?? null;
    if (aCod === null && bCod !== null) return 1;
    if (aCod !== null && bCod === null) return -1;
    if (aCod !== null && bCod !== null) {
      const cmp = aCod.localeCompare(bCod);
      if (cmp !== 0) return cmp;
    }
    return a.criada_em.localeCompare(b.criada_em);
  });
  return rows;
}

export async function obterPendencia(id: string): Promise<PendenciaJoined | null> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .select(
      `
        *,
        produto:siso_produtos(sku, descricao, imagem_url),
        galpao:siso_galpoes(nome),
        localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
        localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo, tipo)
`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return normalizarNumeros(data as unknown as PendenciaJoined);
}

function normalizarNumeros(p: PendenciaJoined): PendenciaJoined {
  return {
    ...p,
    qty_inicial: Number(p.qty_inicial),
    qty_guardada: Number(p.qty_guardada),
    qty_pendente: Number(p.qty_pendente),
    custo_unitario: p.custo_unitario === null ? null : Number(p.custo_unitario),
  };
}

/**
 * Marca pendência como em_guarda. Idempotente pra re-entrada do MESMO
 * operador. Anti-race via UPDATE condicional: se outro operador já
 * "reivindicou" a pendência (iniciada_por != usuario_id), retorna erro
 * com code='PENDENCIA_OUTRA_GUARDA' + atributo `iniciada_por` pra UI
 * mostrar quem é o dono atual.
 *
 * Sem o UPDATE condicional, 2 operadores clicando "Iniciar" em paralelo
 * passariam ambos pelo SELECT e fariam ambos os UPDATEs — o segundo
 * sobrescreveria `iniciada_por` silenciosamente, corrompendo a atribuição.
 *
 * Erros possíveis:
 *   - "pendência não encontrada" (400)
 *   - "pendência em status terminal" — guardada|cancelada (400)
 *   - code='PENDENCIA_OUTRA_GUARDA' (409) — outro operador é dono atual
 */
export async function iniciarGuarda(input: {
  pendencia_id: string;
  usuario_id: string;
}): Promise<PendenciaJoined> {
  const sb = createServiceClient();
  const pend = await obterPendencia(input.pendencia_id);
  if (!pend) throw new Error("pendência não encontrada");
  if (pend.status === "guardada" || pend.status === "cancelada") {
    throw new Error(`pendência em status terminal (${pend.status})`);
  }
  // Re-entrada do mesmo operador: idempotente.
  if (pend.status === "em_guarda" && pend.iniciada_por === input.usuario_id) {
    return pend;
  }
  // Já reivindicada por outro operador — não tenta sobrescrever.
  if (
    pend.status === "em_guarda" &&
    pend.iniciada_por &&
    pend.iniciada_por !== input.usuario_id
  ) {
    const err = new Error(
      `pendência já está em_guarda com outro operador (${pend.iniciada_por})`,
    ) as Error & { code?: string; iniciada_por?: string };
    err.code = "PENDENCIA_OUTRA_GUARDA";
    err.iniciada_por = pend.iniciada_por;
    throw err;
  }
  // UPDATE condicional: só ganha se `iniciada_por` ainda for NULL ou já
  // for o usuário atual, E o status não tiver virado terminal entre o
  // SELECT e este UPDATE. Race-perdedor recebe 0 rows updated.
  const { data: updated, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .update({
      status: "em_guarda",
      iniciada_em: new Date().toISOString(),
      iniciada_por: input.usuario_id,
    })
    .eq("id", input.pendencia_id)
    .or(`iniciada_por.is.null,iniciada_por.eq.${input.usuario_id}`)
    .neq("status", "guardada")
    .neq("status", "cancelada")
    .select("id, iniciada_por");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    // Race perdida: outro operador ganhou. Re-lê pra anexar o dono atual.
    const refreshed = await obterPendencia(input.pendencia_id);
    const err = new Error(
      `pendência foi reivindicada por outro operador (${refreshed?.iniciada_por ?? "?"})`,
    ) as Error & { code?: string; iniciada_por?: string };
    err.code = "PENDENCIA_OUTRA_GUARDA";
    err.iniciada_por = refreshed?.iniciada_por ?? undefined;
    throw err;
  }

  const refresh = await obterPendencia(input.pendencia_id);
  if (!refresh) throw new Error("pendência sumiu após iniciar (race condition)");
  return refresh;
}

export interface ConfirmarGuardaInput {
  pendencia_id: string;
  qty: number;
  localizacao_destino_id: string;
  usuario_id: string;
}

export interface ConfirmarGuardaResult {
  pendencia: PendenciaJoined;
  origem_id: string;
  totalmente_guardada: boolean;
}

/**
 * Confirma uma guarda (parcial ou total). Faz a mov par S+E NEUTRO
 * (replenishment_intra) saindo da loc RECEBIMENTO e entrando na loc destino.
 *
 * Validações:
 *   - pendência existe e não está terminal
 *   - qty > 0 e <= qty_pendente
 *   - loc destino existe, é do mesmo galpão e ≠ loc origem (recebimento)
 *
 * Em 3D, o custo médio é global por produto (siso_custo_medio) — não precisa
 * mais propagar `custo_medio` entre locs no put-away.
 *
 * Atomicidade (P3 #5.3 + #5.8): RPC `wms_confirmar_guarda_atomico` faz tudo
 * (FOR UPDATE no row da pendência + S+E par + UPDATE status) numa única
 * transação. Concorrentes esperam no lock; race entre leitura e UPDATE
 * não causa mais over-decremento.
 */
export async function confirmarGuarda(
  input: ConfirmarGuardaInput,
): Promise<ConfirmarGuardaResult> {
  if (!input.qty || input.qty <= 0) {
    throw new Error("qty deve ser > 0");
  }

  // P3 #5.3 + #5.8: tudo dentro de RPC plpgsql com FOR UPDATE no row da
  // pendência + replenishment atômico + update de status — na mesma
  // transação. Concorrentes esperam no lock; race entre leitura e UPDATE
  // não causa mais over-decremento.
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_confirmar_guarda_atomico", {
    p_pendencia_id: input.pendencia_id,
    p_qty: input.qty,
    p_localizacao_destino_id: input.localizacao_destino_id,
    p_usuario_id: input.usuario_id,
  });
  if (error) {
    logger.error(LOG_SOURCE, "confirmarGuarda RPC falhou", {
      pendenciaId: input.pendencia_id,
      message: error.message,
    });
    // Repassa a mensagem do PG sem prefixos pra preservar contratos atuais
    // (ex.: cenário 8 e 42 esperam strings específicas).
    throw new Error(error.message);
  }
  const r = data as {
    pendencia_id: string;
    origem_id: string;
    mov_ids: string[];
    totalmente_guardada: boolean;
    qty_guardada: number;
    status: string;
  };

  logger.info(LOG_SOURCE, "guarda confirmada", {
    pendenciaId: input.pendencia_id,
    qty: String(input.qty),
    totalmenteGuardada: String(r.totalmente_guardada),
    origemId: r.origem_id,
  });

  const refresh = await obterPendencia(input.pendencia_id);
  if (!refresh) throw new Error("pendência sumiu após confirmar");

  return {
    pendencia: refresh,
    origem_id: r.origem_id,
    totalmente_guardada: r.totalmente_guardada,
  };
}

export interface CancelarPendenciaInput {
  pendencia_id: string;
  motivo: string;
  usuario_id: string;
}

/**
 * Cancela pendência sem mover estoque. A peça continua na loc RECEBIMENTO
 * (saldo intacto). Útil pra registrar "peça sumiu" / "devolvida ao
 * fornecedor" — a saída do estoque deve ser feita em outro fluxo (ajuste
 * ou devolucao_fornecedor_enviada). Cancelamento aqui = "tirar da fila".
 */
export async function cancelarPendencia(
  input: CancelarPendenciaInput,
): Promise<PendenciaJoined> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do cancelamento é obrigatório (≥3 caracteres)");
  }
  const pend = await obterPendencia(input.pendencia_id);
  if (!pend) throw new Error("pendência não encontrada");
  if (pend.status === "guardada" || pend.status === "cancelada") {
    throw new Error(`pendência em status terminal (${pend.status})`);
  }

  const sb = createServiceClient();
  const { error } = await sb
    .from("siso_wms_pendencias_guarda")
    .update({
      status: "cancelada",
      cancelada_em: new Date().toISOString(),
      cancelada_por: input.usuario_id,
      motivo_cancelamento: input.motivo.trim(),
    })
    .eq("id", input.pendencia_id);
  if (error) throw error;

  logger.info(LOG_SOURCE, "pendência cancelada", {
    pendenciaId: input.pendencia_id,
    motivo: input.motivo,
  });

  const refresh = await obterPendencia(input.pendencia_id);
  if (!refresh) throw new Error("pendência sumiu após cancelar");
  return refresh;
}

/**
 * P3 #5.1: desfaz uma guarda confirmada (total ou parcial).
 *
 * Estorna o par S+E intra-galpão (pendência → loc_destino vira loc_destino → pendência),
 * decrementa qty_guardada, devolve status pra 'pendente' (ou 'em_guarda' se ainda
 * houver qty_pendente).
 *
 * Sem qty: desfaz a última confirmação (qty_guardada não-zero mais recente).
 * Com qty: desfaz exatamente qty unidades (deve ≤ qty_guardada).
 *
 * Limitação: a pendência tem que estar em status 'pendente' ou 'guardada' (não cancelada).
 */
export async function desfazerGuarda(input: {
  pendencia_id: string;
  qty?: number;
  usuario_id: string;
  motivo: string;
}): Promise<{ pendencia: PendenciaJoined; movsEstornadas: number }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do undo é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const pend = await obterPendencia(input.pendencia_id);
  if (!pend) throw new Error("pendência não encontrada");
  if (pend.status === "cancelada") {
    throw new Error("pendência cancelada — undo de guarda não se aplica");
  }
  if (Number(pend.qty_guardada) === 0) {
    throw new Error("pendência sem guardas confirmadas — nada a desfazer");
  }

  // Localiza as movs E (entrada na loc destino) ligadas a essa pendência.
  // origem_id das movs do replenishmentIntraGalpao é o lote da confirmação;
  // o link é via origem_tipo='transferencia_localizacao' + galpao_id +
  // produto_id + janela temporal. Mais simples: usar mov_entrada_id da
  // pendência como pivot.
  //
  // Estratégia: buscar todas as movs do par (S na loc RECEBIMENTO + E na
  // loc destino) com origem_tipo='transferencia_localizacao' e
  // origem_id IN (lista de confirmações dessa pendência).
  //
  // Idempotência: estornarMovimentacao recusa double-estorno. Se 2 chamadas
  // de desfazer chegam, 2ª retorna 0 estornadas.

  // P3 #5.1 simplificação: requer 1 confirmação por pendência (sem qty parcial
  // configurável aqui no MVP). Operador pode desfazer "a guarda" — estorna
  // exatamente qty_guardada. Se desfazer parcial for necessário, escalar
  // pra task futura.
  if (input.qty && input.qty !== Number(pend.qty_guardada)) {
    throw new Error(
      "MVP: desfazer parcial não suportado. Omita qty pra desfazer toda a guarda atual.",
    );
  }

  // Estorna par S+E. Busca movs por origem_id compartilhada com a confirmação.
  // confirmarGuarda compartilha origem_id entre as 2 movs (RPC garante).
  // Mas hoje pendência não armazena os origem_id das confirmações — vamos
  // adicionar coluna tracking_origem_ids text[] em migration separada.
  //
  // Fluxo MVP sem migration: busca movs pela tripla + janela [iniciada_em, now].
  const triplaProduto = pend.produto_id;
  const galpao = pend.galpao_id;
  const locOrigem = pend.localizacao_origem_id;

  const { data: movsS } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, criado_em, quantidade, localizacao_id")
    .eq("origem_tipo", "transferencia_localizacao")
    .eq("produto_id", triplaProduto)
    .eq("galpao_id", galpao)
    .eq("localizacao_id", locOrigem)
    .eq("tipo", "S")
    .gte("criado_em", pend.iniciada_em ?? pend.criada_em ?? "1970-01-01")
    .order("criado_em", { ascending: false });

  // Filtra apenas os pares que ainda não foram estornados.
  const candidatos = (movsS ?? []) as Array<{
    id: string;
    origem_id: string;
    quantidade: number;
  }>;
  let movsEstornadas = 0;
  let qtyDesfeita = 0;
  const qtyAlvo = Number(input.qty ?? pend.qty_guardada);

  for (const m of candidatos) {
    if (qtyDesfeita >= qtyAlvo) break;
    try {
      // Estorna par: a S na origem + a E na destino. Ambas têm o mesmo origem_id.
      const { data: par } = await sb
        .from("siso_movimentacoes")
        .select("id, tipo")
        .eq("origem_id", m.origem_id)
        .eq("origem_tipo", "transferencia_localizacao");
      for (const p of (par ?? []) as Array<{ id: string; tipo: string }>) {
        await estornarMovimentacao({
          mov_id: p.id,
          usuario_id: input.usuario_id,
          motivo: `Desfaz guarda pendência ${input.pendencia_id}: ${input.motivo}`,
        });
        movsEstornadas++;
      }
      qtyDesfeita += Number(m.quantidade);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/já foi estornada|já é um estorno/.test(msg)) continue;
      throw err;
    }
  }

  // Atualiza pendência: decrementa qty_guardada, volta status.
  const novaQtyGuardada = Math.max(0, Number(pend.qty_guardada) - qtyDesfeita);
  const novoStatus = novaQtyGuardada > 0 ? "em_guarda" : "pendente";
  await sb
    .from("siso_wms_pendencias_guarda")
    .update({
      qty_guardada: novaQtyGuardada,
      status: novoStatus,
      guardada_em:
        novaQtyGuardada >= Number(pend.qty_inicial) ? pend.guardada_em : null,
    })
    .eq("id", input.pendencia_id);

  logger.info(LOG_SOURCE, "guarda desfeita", {
    pendenciaId: input.pendencia_id,
    qtyDesfeita: String(qtyDesfeita),
    movsEstornadas: String(movsEstornadas),
    novoStatus,
  });

  const refresh = await obterPendencia(input.pendencia_id);
  if (!refresh) throw new Error("pendência sumiu após desfazer");
  return { pendencia: refresh, movsEstornadas };
}

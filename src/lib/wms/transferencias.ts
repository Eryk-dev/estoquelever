import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao, estornarMovimentacao } from "./ledger";

// ─── Tipos ────────────────────────────────────────────────────────────────

export interface CriarTransferenciaInput {
  galpao_origem_id: string;
  galpao_destino_id: string;
  itens: Array<{
    produto_id: string;
    localizacao_origem_id: string;
    qty: number;
  }>;
  observacoes?: string;
  usuario_id: string;
}

export interface ReceberTransferenciaInput {
  transferencia_id: string;
  itens: Array<{
    transferencia_item_id: string;
    localizacao_destino_id: string;
  }>;
  usuario_id: string;
}

export type StatusTransferencia = "em_transito" | "recebida" | "cancelada";

interface TransferenciaItemRow {
  id: string;
  produto_id: string;
  localizacao_origem_id: string;
  qty: number;
  localizacao_destino_id: string | null;
  mov_saida_id: string | null;
  mov_entrada_id: string | null;
  mov_estorno_id: string | null;
  produto?: { sku: string; descricao: string };
  localizacao_origem?: { codigo: string };
  localizacao_destino?: { codigo: string } | null;
}

interface TransferenciaRow {
  id: string;
  galpao_origem_id: string;
  galpao_destino_id: string;
  status: StatusTransferencia;
  criada_em: string;
  recebida_em: string | null;
  cancelada_em: string | null;
  observacoes: string | null;
  galpao_origem?: { nome: string };
  galpao_destino?: { nome: string };
  criada_por_user?: { nome: string };
  itens?: TransferenciaItemRow[];
}

// ─── Criar ────────────────────────────────────────────────────────────────

/**
 * Cria transferência inter-galpão. Em 3D, par S+E NEUTRO (sem empresa) —
 * estoque migra dum galpão pra outro sem carregar dona.
 */
export async function criarTransferencia(
  input: CriarTransferenciaInput,
): Promise<{ id: string }> {
  if (input.galpao_origem_id === input.galpao_destino_id) {
    throw new Error(
      "transferência inter-galpão exige galpões diferentes (use realocação)",
    );
  }
  if (!input.itens.length) {
    throw new Error("transferência sem itens");
  }
  const sb = createServiceClient();

  // 1) Insere header
  const { data: header, error: errHeader } = await sb
    .from("siso_transferencias_galpao")
    .insert({
      galpao_origem_id: input.galpao_origem_id,
      galpao_destino_id: input.galpao_destino_id,
      criada_por: input.usuario_id,
      observacoes: input.observacoes ?? null,
    })
    .select("id")
    .single();
  if (errHeader || !header) throw errHeader ?? new Error("falha ao criar header");
  const transferenciaId = (header as { id: string }).id;

  // 2) Pra cada item: gera SAÍDA na origem (estoque sai) + insere row
  // Se qualquer movimento falhar (saldo insuficiente), reverte tudo: estornar
  // movs já criadas, deletar itens, deletar header.
  const itensCriados: Array<{ item_id: string; mov_id: string }> = [];
  try {
    for (const item of input.itens) {
      // Insere row do item primeiro (pra ter o id pro mov.origem_id)
      const { data: itemRow, error: errItem } = await sb
        .from("siso_transferencia_galpao_itens")
        .insert({
          transferencia_id: transferenciaId,
          produto_id: item.produto_id,
          localizacao_origem_id: item.localizacao_origem_id,
          qty: item.qty,
        })
        .select("id")
        .single();
      if (errItem || !itemRow) throw errItem ?? new Error("falha ao criar item");
      const itemId = (itemRow as { id: string }).id;

      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: item.produto_id,
          galpao_id: input.galpao_origem_id,
          localizacao_id: item.localizacao_origem_id,
        },
        tipo: "S",
        qty: item.qty,
        origem_tipo: "transferencia_galpao",
        origem_id: transferenciaId,
        usuario_id: input.usuario_id,
        motivo: input.observacoes,
      });

      await sb
        .from("siso_transferencia_galpao_itens")
        .update({ mov_saida_id: mov.id })
        .eq("id", itemId);

      itensCriados.push({ item_id: itemId, mov_id: mov.id });
    }
  } catch (e) {
    // Rollback: estorna cada saída criada
    for (const c of itensCriados) {
      try {
        const item = input.itens[itensCriados.indexOf(c)];
        await inserirMovimentacao({
          tripla: {
            produto_id: item.produto_id,
            galpao_id: input.galpao_origem_id,
            localizacao_id: item.localizacao_origem_id,
          },
          tipo: "E",
          qty: item.qty,
          origem_tipo: "estorno",
          estorno_de: c.mov_id,
          usuario_id: input.usuario_id,
          motivo: "rollback de criação de transferência",
        });
      } catch {
        // best-effort
      }
    }
    await sb
      .from("siso_transferencias_galpao")
      .delete()
      .eq("id", transferenciaId);
    throw e;
  }

  return { id: transferenciaId };
}

// ─── Listar ───────────────────────────────────────────────────────────────

export interface ListarFiltros {
  status?: StatusTransferencia;
  galpao_origem_id?: string;
  galpao_destino_id?: string;
  limit?: number;
}

export async function listarTransferencias(
  filtros: ListarFiltros = {},
): Promise<TransferenciaRow[]> {
  const sb = createServiceClient();
  let q = sb
    .from("siso_transferencias_galpao")
    .select(
      `
        id, galpao_origem_id, galpao_destino_id, status,
        criada_em, recebida_em, cancelada_em, observacoes,
        galpao_origem:siso_galpoes!galpao_origem_id(nome),
        galpao_destino:siso_galpoes!galpao_destino_id(nome),
        criada_por_user:siso_usuarios!criada_por(nome),
        itens:siso_transferencia_galpao_itens(
          id, produto_id, localizacao_origem_id, qty,
          localizacao_destino_id, mov_saida_id, mov_entrada_id, mov_estorno_id,
          produto:siso_produtos(sku, descricao),
          localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
          localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo)
        )
      `,
    )
    .order("criada_em", { ascending: false })
    .limit(filtros.limit ?? 100);

  if (filtros.status) q = q.eq("status", filtros.status);
  if (filtros.galpao_origem_id) q = q.eq("galpao_origem_id", filtros.galpao_origem_id);
  if (filtros.galpao_destino_id) q = q.eq("galpao_destino_id", filtros.galpao_destino_id);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as TransferenciaRow[];
}

export async function getTransferencia(
  id: string,
): Promise<TransferenciaRow | null> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_transferencias_galpao")
    .select(
      `
        id, galpao_origem_id, galpao_destino_id, status,
        criada_em, recebida_em, cancelada_em, observacoes,
        galpao_origem:siso_galpoes!galpao_origem_id(nome),
        galpao_destino:siso_galpoes!galpao_destino_id(nome),
        criada_por_user:siso_usuarios!criada_por(nome),
        itens:siso_transferencia_galpao_itens(
          id, produto_id, localizacao_origem_id, qty,
          localizacao_destino_id, mov_saida_id, mov_entrada_id, mov_estorno_id,
          produto:siso_produtos(sku, descricao),
          localizacao_origem:siso_localizacoes!localizacao_origem_id(codigo),
          localizacao_destino:siso_localizacoes!localizacao_destino_id(codigo)
        )
      `,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as TransferenciaRow | null;
}

// ─── Receber ──────────────────────────────────────────────────────────────

/**
 * Recebe uma transferência em trânsito. Gera mov E na loc destino pra cada
 * item informado, atualiza `mov_entrada_id` + `localizacao_destino_id` em cada
 * row de item, e flipa o header pra `status='recebida'`.
 *
 * **P3 #8.10 — Anti-race (2026-05-27):**
 * Sem proteção, 2 operadores chamando /receber em paralelo passariam ambos a
 * validação de `status='em_transito'` (SELECTs separados), inseririam movs E
 * duas vezes (saldo dobrado no destino), e o último UPDATE de status='recebida'
 * sobrescreveria silenciosamente. Agora, antes de inserir as movs, tentamos
 * reivindicar o header via UPDATE condicional setando
 * `recebimento_em_andamento_por`. WHERE id=$1 AND status='em_transito' AND
 * `recebimento_em_andamento_por IS NULL` (claim **estrito** — diferente de
 * `iniciarGuarda` que tolera re-entrada do mesmo user porque o inner write
 * é idempotente). Aqui o inner write é INSERT de mov E (não-idempotente até
 * `mov_entrada_id` ser setado), então 2 chamadas paralelas do MESMO user
 * também precisam serializar. Loser leva 0 rows → 409 com
 * `code='TRANSFERENCIA_OUTRO_RECEBIMENTO'` + `recebimento_em_andamento_por`
 * pra UI mostrar quem ganhou.
 *
 * Ao fim do happy-path, o campo é zerado junto com o flip pra `status='recebida'`.
 * Se o processo morrer no meio, o campo fica "preso" — admin pode limpar manual.
 * Trade-off aceito: retry após crash exige cleanup (vs. risco de saldo duplicado).
 */
export async function receberTransferencia(
  input: ReceberTransferenciaInput,
): Promise<void> {
  const sb = createServiceClient();

  const { data: transf, error: errHeader } = await sb
    .from("siso_transferencias_galpao")
    .select("id, status, galpao_destino_id, recebimento_em_andamento_por")
    .eq("id", input.transferencia_id)
    .single();
  if (errHeader || !transf) throw new Error("transferência não encontrada");
  const t = transf as {
    id: string;
    status: StatusTransferencia;
    galpao_destino_id: string;
    recebimento_em_andamento_por: string | null;
  };
  if (t.status !== "em_transito") {
    throw new Error(
      `transferência não está em trânsito (status: ${t.status})`,
    );
  }

  // P3 #8.10: Se já tem alguém com o lock, rejeita imediatamente (sem
  // round-trip extra no UPDATE). Claim é ESTRITO — mesmo o mesmo user
  // não pode entrar duas vezes (inner write não é idempotente).
  if (t.recebimento_em_andamento_por) {
    const err = new Error(
      `recebimento já em andamento por outro operador (${t.recebimento_em_andamento_por})`,
    ) as Error & { code?: string; recebimento_em_andamento_por?: string };
    err.code = "TRANSFERENCIA_OUTRO_RECEBIMENTO";
    err.recebimento_em_andamento_por = t.recebimento_em_andamento_por;
    throw err;
  }

  // P3 #8.10: UPDATE condicional pra reivindicar o recebimento. Claim
  // estrito: só passa se `recebimento_em_andamento_por IS NULL`. Loser
  // (qualquer chamada concorrente) leva 0 rows → 409.
  const { data: claimed, error: errClaim } = await sb
    .from("siso_transferencias_galpao")
    .update({
      recebimento_em_andamento_por: input.usuario_id,
      recebimento_em_andamento_em: new Date().toISOString(),
    })
    .eq("id", t.id)
    .eq("status", "em_transito")
    .is("recebimento_em_andamento_por", null)
    .select("id");
  if (errClaim) throw errClaim;
  if (!claimed || claimed.length === 0) {
    // Race perdida entre o SELECT e o UPDATE — re-lê pra anexar o dono atual.
    const { data: refreshed } = await sb
      .from("siso_transferencias_galpao")
      .select("recebimento_em_andamento_por, status")
      .eq("id", t.id)
      .single();
    const r = refreshed as
      | { recebimento_em_andamento_por: string | null; status: StatusTransferencia }
      | null;
    const err = new Error(
      `recebimento já em andamento por outro operador (${r?.recebimento_em_andamento_por ?? "?"})`,
    ) as Error & { code?: string; recebimento_em_andamento_por?: string };
    err.code = "TRANSFERENCIA_OUTRO_RECEBIMENTO";
    err.recebimento_em_andamento_por = r?.recebimento_em_andamento_por ?? undefined;
    throw err;
  }

  try {
    const { data: itens, error: errItens } = await sb
      .from("siso_transferencia_galpao_itens")
      .select("id, produto_id, qty, mov_entrada_id")
      .eq("transferencia_id", input.transferencia_id);
    if (errItens || !itens) throw new Error("itens não encontrados");
    type ItemRow = {
      id: string;
      produto_id: string;
      qty: number;
      mov_entrada_id: string | null;
    };
    const itensMap = new Map(
      ((itens ?? []) as ItemRow[]).map((i) => [i.id, i]),
    );

    // Valida que veio loc destino pra TODOS os itens não-recebidos
    for (const it of itens as ItemRow[]) {
      if (it.mov_entrada_id) continue;
      const sel = input.itens.find((x) => x.transferencia_item_id === it.id);
      if (!sel) {
        throw new Error(
          `localização de destino faltando pra item ${it.id}`,
        );
      }
    }

    // Pra cada item informado: gera entrada na loc destino
    for (const sel of input.itens) {
      const item = itensMap.get(sel.transferencia_item_id);
      if (!item) throw new Error(`item ${sel.transferencia_item_id} não pertence à transferência`);
      if (item.mov_entrada_id) continue; // já recebido — idempotência

      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: item.produto_id,
          galpao_id: t.galpao_destino_id,
          localizacao_id: sel.localizacao_destino_id,
        },
        tipo: "E",
        qty: item.qty,
        origem_tipo: "transferencia_galpao",
        origem_id: t.id,
        usuario_id: input.usuario_id,
        motivo: "recebimento de transferência inter-galpão",
      });
      await sb
        .from("siso_transferencia_galpao_itens")
        .update({
          localizacao_destino_id: sel.localizacao_destino_id,
          mov_entrada_id: mov.id,
        })
        .eq("id", sel.transferencia_item_id);
    }

    // Happy-path: flipa header e zera o lock atomicamente no mesmo UPDATE.
    await sb
      .from("siso_transferencias_galpao")
      .update({
        status: "recebida",
        recebida_por: input.usuario_id,
        recebida_em: new Date().toISOString(),
        recebimento_em_andamento_por: null,
      })
      .eq("id", t.id);
  } catch (e) {
    // Sad-path: tenta limpar o lock pra não deixar o header travado. Só
    // limpa se ainda formos o dono (proteção contra interleavings exóticos).
    try {
      await sb
        .from("siso_transferencias_galpao")
        .update({ recebimento_em_andamento_por: null })
        .eq("id", t.id)
        .eq("recebimento_em_andamento_por", input.usuario_id);
    } catch {
      // best-effort
    }
    throw e;
  }
}

// ─── Cancelar ─────────────────────────────────────────────────────────────

/**
 * Cancela uma transferência inter-galpão **em trânsito**, estornando todas as
 * legs já materializadas — inclusive itens já recebidos no destino (parcial).
 *
 * P3 #8.3 (2026-05-27): hardening do cenário "em_transito com items já
 * recebidos". A versão anterior estornava só as legs S (origem) — se algum
 * item tivesse `mov_entrada_id` setado (recebimento parcial via race, undo
 * de recebimento que deixou estado intermediário, ou cancelamento durante
 * recebimento), a leg E ficaria órfã no destino. Agora estornamos primeiro
 * as legs E (de itens com `mov_entrada_id`), depois as legs S do header,
 * resetamos os campos do item e marcamos o header como cancelada.
 *
 * Schema deviation documentada (vs spec):
 * - O schema só conhece status ∈ {'em_transito','recebida','cancelada'}.
 *   `recebida_parcial` (proposto no plano) não existe — `receberTransferencia`
 *   é atômico (recebe todos ou rejeita). Status `'recebida'` é REJEITADO
 *   aqui com mensagem apontando pra `/desfazer-recebimento` (que volta o
 *   header pra `em_transito` antes de re-cancelar).
 *
 * Requisitos:
 * - Status do header DEVE ser `em_transito`. `recebida` → erro com hint.
 *   `cancelada` → erro idempotência (já cancelado).
 *
 * Efeito:
 * - Pra cada item com `mov_entrada_id` (recebido parcialmente, sem estorno
 *   ainda): estorna a leg E via `estornarMovimentacao` (idempotente — se a
 *   mov já tem estorno, é ignorada).
 * - Pra cada item com `mov_saida_id` e sem `mov_estorno_id`: estorna a leg
 *   S na origem (par E na loc origem).
 * - Reseta `mov_entrada_id=null` e `localizacao_destino_id=null` nos itens
 *   que tinham recebimento parcial (mantém audit do `mov_saida_id` +
 *   `mov_estorno_id`).
 * - Atualiza header pra `status='cancelada'` + `cancelada_em=now()` +
 *   `cancelada_por=usuario_id`.
 *
 * @returns `{ movsEstornadas, itensComRecebimentoParcial }`
 *   - `movsEstornadas` — total de movs estornadas (E + S).
 *   - `itensComRecebimentoParcial` — quantos itens tinham `mov_entrada_id`
 *     setado no momento do cancelamento (zero quando 100% em_transito puro).
 */
export async function cancelarTransferencia(
  transferenciaId: string,
  usuarioId: string,
): Promise<{ movsEstornadas: number; itensComRecebimentoParcial: number }> {
  const sb = createServiceClient();
  const { data: transf, error } = await sb
    .from("siso_transferencias_galpao")
    .select(
      "id, status, galpao_origem_id, recebimento_em_andamento_por, recebimento_em_andamento_em",
    )
    .eq("id", transferenciaId)
    .single();
  if (error || !transf) throw new Error("transferência não encontrada");
  const t = transf as {
    id: string;
    status: StatusTransferencia;
    galpao_origem_id: string;
    recebimento_em_andamento_por: string | null;
    recebimento_em_andamento_em: string | null;
  };
  if (t.status === "recebida") {
    throw new Error(
      `transferência já foi recebida — use POST /api/wms/transferencias/${transferenciaId}/desfazer-recebimento antes de cancelar`,
    );
  }
  if (t.status !== "em_transito") {
    throw new Error(
      `só transferências em trânsito podem ser canceladas (status: ${t.status})`,
    );
  }

  // P062/P066/P068: respeita o lock de recebimento. Outro operador recebendo
  // dentro da janela de 30min bloqueia o cancel (409). O próprio recebedor ou
  // um lock stale (>30min, tela do recebedor caiu) liberam o cancel.
  const LOCK_TTL_MS = 30 * 60_000;
  const lockAtivo =
    t.recebimento_em_andamento_por != null &&
    t.recebimento_em_andamento_por !== usuarioId &&
    t.recebimento_em_andamento_em != null &&
    Date.now() - new Date(t.recebimento_em_andamento_em).getTime() < LOCK_TTL_MS;
  if (lockAtivo) {
    const err = new Error(
      `recebimento em andamento por outro operador (${t.recebimento_em_andamento_por}) — não é possível cancelar agora`,
    ) as Error & { code?: string };
    err.code = "TRANSFERENCIA_RECEBIMENTO_EM_ANDAMENTO";
    throw err;
  }

  // Claim atômico de cancelamento: fecha a janela TOCTOU entre o SELECT acima e
  // os estornos abaixo. Só passa se ainda em_transito E (sem lock OU lock do
  // próprio usuário OU lock stale). O claim seta o lock pra nós (mutex
  // compartilhado com o receber), serializando os dois fluxos.
  const staleCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const claimQuery = sb
    .from("siso_transferencias_galpao")
    .update({
      recebimento_em_andamento_por: usuarioId,
      recebimento_em_andamento_em: new Date().toISOString(),
    })
    .eq("id", t.id)
    .eq("status", "em_transito")
    .or(
      `recebimento_em_andamento_por.is.null,recebimento_em_andamento_por.eq.${usuarioId},recebimento_em_andamento_em.lt.${staleCutoff}`,
    )
    .select("id");
  const { data: claimed } = await claimQuery;
  if (!claimed || claimed.length === 0) {
    const err = new Error(
      `transferência sendo recebida/cancelada por outro operador, tente em alguns segundos`,
    ) as Error & { code?: string };
    err.code = "TRANSFERENCIA_RECEBIMENTO_EM_ANDAMENTO";
    throw err;
  }

  const { data: itens } = await sb
    .from("siso_transferencia_galpao_itens")
    .select(
      "id, produto_id, qty, localizacao_origem_id, mov_saida_id, mov_entrada_id, mov_estorno_id",
    )
    .eq("transferencia_id", transferenciaId);
  type ItemRow = {
    id: string;
    produto_id: string;
    qty: number;
    localizacao_origem_id: string;
    mov_saida_id: string | null;
    mov_entrada_id: string | null;
    mov_estorno_id: string | null;
  };
  const rows = ((itens ?? []) as ItemRow[]);

  let movsEstornadas = 0;
  let itensComRecebimentoParcial = 0;

  // 1) Estorna leg E (entrada destino) pra cada item com recebimento parcial.
  //    Usa estornarMovimentacao (idempotente — rejeita double-estorno).
  for (const it of rows) {
    if (!it.mov_entrada_id) continue;
    itensComRecebimentoParcial++;
    try {
      await estornarMovimentacao({
        mov_id: it.mov_entrada_id,
        usuario_id: usuarioId,
        motivo: `Cancelamento de transferência ${transferenciaId} (estorno leg E)`,
      });
      movsEstornadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotência: tolera leg E já estornada.
      if (/já foi estornada|já é um estorno/.test(msg)) continue;
      throw err;
    }
  }

  // 2) Estorna leg S (saída origem) — preserva audit em mov_estorno_id.
  for (const it of rows) {
    if (it.mov_estorno_id || !it.mov_saida_id) continue;
    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: it.produto_id,
        galpao_id: t.galpao_origem_id,
        localizacao_id: it.localizacao_origem_id,
      },
      tipo: "E",
      qty: it.qty,
      origem_tipo: "estorno",
      estorno_de: it.mov_saida_id,
      usuario_id: usuarioId,
      motivo: "cancelamento de transferência inter-galpão",
    });
    await sb
      .from("siso_transferencia_galpao_itens")
      .update({ mov_estorno_id: mov.id })
      .eq("id", it.id);
    movsEstornadas++;
  }

  // 3) Reseta itens com recebimento parcial (mantém mov_saida_id +
  //    mov_estorno_id pra audit; só limpa o caminho do destino).
  if (itensComRecebimentoParcial > 0) {
    await sb
      .from("siso_transferencia_galpao_itens")
      .update({
        mov_entrada_id: null,
        localizacao_destino_id: null,
      })
      .eq("transferencia_id", transferenciaId)
      .not("mov_entrada_id", "is", null);
  }

  // 4) Marca header cancelada e limpa o lock de cancelamento.
  await sb
    .from("siso_transferencias_galpao")
    .update({
      status: "cancelada",
      cancelada_por: usuarioId,
      cancelada_em: new Date().toISOString(),
      recebimento_em_andamento_por: null,
      recebimento_em_andamento_em: null,
    })
    .eq("id", transferenciaId);

  return { movsEstornadas, itensComRecebimentoParcial };
}

// ─── Desfazer recebimento (P3 #8.2) ───────────────────────────────────────

/**
 * Desfaz o recebimento de uma transferência inter-galpão. Estorna **apenas**
 * a leg E (entrada destino) — a leg S (saída origem) permanece intacta porque
 * o estoque ainda está "em trânsito" (saiu do galpão origem, só não foi
 * fisicamente recebido no destino, ou recebido com erro).
 *
 * Efeito:
 * - Cada `mov_entrada_id` setado na transferência é estornado (par E→S na
 *   loc destino). Estornos já aplicados são ignorados (idempotência via
 *   `estornarMovimentacao` que rejeita double-estorno).
 * - Itens resetam `mov_entrada_id=NULL` e `localizacao_destino_id=NULL`.
 * - Header volta pra `status='em_transito'` e `recebida_em=NULL`.
 *
 * Permite re-receber depois.
 *
 * Requisitos:
 * - `motivo` (≥3 chars) obrigatório.
 * - Header deve estar em `recebida` (única status válida hoje;
 *   `recebida_parcial` previsto em futuras evoluções).
 *
 * @returns `{ movsEstornadas }` — quantas movs E foram efetivamente estornadas
 */
export async function desfazerRecebimentoTransferencia(input: {
  transferencia_id: string;
  usuario_id: string;
  motivo: string;
  force?: boolean;
}): Promise<{ movsEstornadas: number }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do undo é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();

  // 1) Fetch header
  const { data: transf, error: errHeader } = await sb
    .from("siso_transferencias_galpao")
    .select("id, status")
    .eq("id", input.transferencia_id)
    .maybeSingle();
  if (errHeader) throw errHeader;
  if (!transf) throw new Error("transferência não encontrada");
  const t = transf as {
    id: string;
    status: StatusTransferencia;
  };

  // 2) Status check — só recebida (ou recebida_parcial se vier no futuro)
  if (t.status !== "recebida") {
    throw new Error(
      `só transferências recebidas podem ter recebimento desfeito (status atual: ${t.status})`,
    );
  }

  // 3) Estorna cada leg E (entrada destino)
  const { data: itens, error: errItens } = await sb
    .from("siso_transferencia_galpao_itens")
    .select("id, mov_entrada_id")
    .eq("transferencia_id", input.transferencia_id);
  if (errItens) throw errItens;

  // [P065] Preflight: pra cada leg E, comparar qty com saldo atual na loc destino.
  // Se algum item não cobre, retornar 409 estruturado 'só dá pra devolver X de Y'
  // SEM mutar nada — exceto se force=true (transparência, não bloqueio absoluto).
  type ItemRow = { id: string; mov_entrada_id: string | null };
  const itensTip = (itens ?? []) as ItemRow[];
  const bloqueados: Array<{ item_id: string; desfazivel: number; total: number }> = [];
  for (const it of itensTip) {
    if (!it.mov_entrada_id) continue;
    const { data: movE } = await sb
      .from("siso_movimentacoes")
      .select("produto_id, galpao_id, localizacao_id, quantidade")
      .eq("id", it.mov_entrada_id)
      .single();
    if (!movE) continue;
    const m = movE as { produto_id: string; galpao_id: string; localizacao_id: string; quantidade: number };
    const { data: est } = await sb
      .from("siso_estoque")
      .select("saldo")
      .match({ produto_id: m.produto_id, galpao_id: m.galpao_id, localizacao_id: m.localizacao_id })
      .maybeSingle();
    const saldo = Number((est as { saldo?: number } | null)?.saldo ?? 0);
    const total = Number(m.quantidade);
    if (saldo < total) {
      bloqueados.push({ item_id: it.id, desfazivel: saldo, total });
    }
  }
  if (bloqueados.length > 0 && !input.force) {
    const linha = bloqueados[0];
    const err = new Error(
      `só pode devolver ${linha.desfazivel} de ${linha.total} (desfazível ${linha.desfazivel} de ${linha.total}) — o resto já saiu da loc destino. Use force=true pra prosseguir só nos itens que cobrem.`,
    ) as Error & { code?: string; bloqueados?: typeof bloqueados };
    err.code = "DESFAZER_PARCIAL_BLOQUEADO";
    err.bloqueados = bloqueados;
    throw err;
  }

  // [P067] Estorno + reset itens + reset header numa única tx atômica.
  const bloqueadosIds = new Set(bloqueados.map((b) => b.item_id));
  if (input.force && bloqueadosIds.size > 0) {
    // force com bloqueados: parcial intencional — desfaz só o que cobre. Mantém
    // loop TS por-item (skip bloqueados) + reset SÓ dos não-bloqueados.
    let movsEstornadas = 0;
    for (const it of itensTip) {
      if (!it.mov_entrada_id || bloqueadosIds.has(it.id)) continue;
      try {
        await estornarMovimentacao({
          mov_id: it.mov_entrada_id,
          usuario_id: input.usuario_id,
          motivo: `Desfaz recebimento de transferência ${input.transferencia_id}: ${input.motivo}`,
        });
        movsEstornadas++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já foi estornada|já é um estorno/.test(msg)) continue;
        throw err;
      }
    }
    for (const it of itensTip) {
      if (bloqueadosIds.has(it.id)) continue;
      await sb
        .from("siso_transferencia_galpao_itens")
        .update({ mov_entrada_id: null, localizacao_destino_id: null })
        .eq("id", it.id);
    }
    return { movsEstornadas };
  }

  // Caminho normal (sem bloqueados ou sem force): RPC atômica faz tudo numa tx.
  const { data, error } = await sb.rpc("wms_desfazer_recebimento_transferencia", {
    p_transferencia_id: input.transferencia_id,
    p_usuario_id: input.usuario_id,
    p_motivo: input.motivo,
  });
  if (error) throw new Error(error.message);
  return { movsEstornadas: (data as { movs_estornadas: number }).movs_estornadas };
}

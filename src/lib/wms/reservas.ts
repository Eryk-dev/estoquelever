import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import type { Tripla, OrigemTipo } from "./types";
import { inserirMovimentacao } from "./ledger";

export function calcularExpiraEm(opts: { now?: Date; horas?: number } = {}): Date {
  const now = opts.now ?? new Date();
  const horas = opts.horas ?? 48;
  return new Date(now.getTime() + horas * 3600 * 1000);
}

export interface ReservarInput {
  tripla: Tripla;
  qty: number;
  pedido_id: string;
  ttl_horas?: number;
  usuario_id?: string;
}

export async function reservarAtomico(input: ReservarInput): Promise<string> {
  const sb = createServiceClient();

  // P003: dedup idempotente — se já existe R viva por (pedido,produto,tripla),
  // retorna o id existente sem inserir nova R. Evita reservado dobrado em
  // reprocessamento/duplo-clique. SEM advisory lock (infra nova descartada).
  const { data: rsExistentes, error: errR } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", input.pedido_id)
    .eq("produto_id", input.tripla.produto_id)
    .eq("galpao_id", input.tripla.galpao_id)
    .eq("localizacao_id", input.tripla.localizacao_id);
  if (errR) {
    // fail-closed: sem poder confirmar ausência de R viva, não inserimos (evita R dupla).
    logger.error("wms.reservas", "falha no dedup de R (P003) — abortando", { error: errR, pedido_id: input.pedido_id });
    throw errR;
  }
  const ids = (rsExistentes ?? []).map((r) => r.id as string);
  if (ids.length > 0) {
    // R é "viva" se não tem L (estorno_de) apontando pra ela.
    const { data: ls } = await sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .in("estorno_de", ids)
      .eq("tipo", "L");
    const liberadas = new Set(
      (ls ?? []).map((l) => l.estorno_de as string | null).filter((x): x is string => !!x),
    );
    const viva = ids.find((id) => !liberadas.has(id));
    if (viva) {
      logger.info("wms.reservas", "R viva já existe — skip idempotente", {
        pedido_id: input.pedido_id,
        produto_id: input.tripla.produto_id,
        reserva_id: viva,
      });
      return viva;
    }
  }

  const { data, error } = await sb.rpc("wms_reservar_atomico", {
    p_produto_id: input.tripla.produto_id,
    p_galpao_id: input.tripla.galpao_id,
    p_localizacao_id: input.tripla.localizacao_id,
    p_quantidade: input.qty,
    p_pedido_id: input.pedido_id,
    p_ttl_horas: input.ttl_horas ?? 48,
    p_usuario_id: input.usuario_id ?? null,
  });
  if (error) {
    logger.error("wms.reservas", "falha ao reservar", { error, input });
    throw error;
  }
  return data as unknown as string;
}

export async function liberarReserva(input: {
  pedido_id: string;
  motivo: "nf_emitida" | "cancelamento" | "expirado";
  usuario_id?: string;
}): Promise<number> {
  const sb = createServiceClient();
  const { data: reservas, error } = await sb
    .from("siso_movimentacoes")
    .select("id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("origem_id", input.pedido_id)
    .eq("origem_tipo", "reserva_pedido")
    .eq("tipo", "R");
  if (error) throw error;

  const { data: jaLiberadas } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("origem_id", input.pedido_id)
    .eq("tipo", "L");
  const temLiberacao = (jaLiberadas?.length ?? 0) > 0;

  let liberados = 0;
  for (const r of (reservas ?? []) as Array<{
    id: string;
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    quantidade: number;
  }>) {
    if (temLiberacao) continue;
    await inserirMovimentacao({
      tripla: {
        produto_id: r.produto_id,
        galpao_id: r.galpao_id,
        localizacao_id: r.localizacao_id,
      },
      tipo: "L",
      qty: Number(r.quantidade),
      origem_tipo: "liberacao_reserva",
      origem_id: input.pedido_id,
      origem_detalhes: { motivo: input.motivo },
      usuario_id: input.usuario_id,
      motivo: `liberada por ${input.motivo}`,
    });
    liberados++;
  }
  return liberados;
}

export interface EstornarReservaInput {
  reserva_id: string;
  motivo: "rollback_aprovacao" | "localizacao_move" | "liberar_reservas_admin" | "outro";
  usuario_id?: string;
}

/**
 * Dependências injetáveis de estornarReservaIndividual.
 * Expostas pra viabilizar testes sem conexão real com o banco
 * (mesmo padrão de injeção usado em roteamento.ts com buscarLinha).
 */
export interface EstornarReservaDeps {
  /** Retorna o id de L já existente com estorno_de=reserva_id, ou null se não existir. */
  buscarLExistente: (reserva_id: string) => Promise<string | null>;
  /** Retorna a reserva R original, ou null se não existir. */
  buscarReservaOriginal: (reserva_id: string) => Promise<{
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    quantidade: number;
    /** origem_id da R (pedido_id em reserva_pedido) — propagado pro L. */
    origem_id: string | null;
  } | null>;
  /** Insere o L no ledger e retorna o id da mov criada. */
  inserirL: (params: {
    reserva_id: string;
    reserva: {
      produto_id: string;
      galpao_id: string;
      localizacao_id: string;
      quantidade: number;
      origem_id: string | null;
    };
    motivo: string;
    usuario_id?: string;
  }) => Promise<string>;
}

/**
 * Estorna UMA reserva específica inserindo L com estorno_de=reserva_id.
 * Diferente de `liberarReserva` (que opera por pedido_id e libera todas as
 * R do pedido), aqui o alvo é individual — usado pra rollback parcial em
 * fluxos atômicos (ex.: aprovar criou 3 R e a 4ª falhou; precisa estornar
 * as 3 sem mexer em reservas de outros pedidos).
 *
 * Idempotente: se já existe L com estorno_de=reserva_id, retorna o id
 * existente sem criar novo L.
 *
 * **Idempotência:** se já existe L com `estorno_de=reserva_id`, retorna o
 * id existente sem criar novo L. Importante: o `motivo` passado em chamadas
 * subsequentes é **ignorado** — first writer wins. Isso é intencional pra
 * evitar reescrever o motivo de um estorno já consumado.
 *
 * Aceita `deps` opcional para injeção de dependências em testes
 * (mesmo padrão de roteamento.ts com buscarLinha).
 */
export async function estornarReservaIndividual(
  input: EstornarReservaInput,
  /** @internal — test seam */
  deps?: EstornarReservaDeps,
): Promise<string> {
  // createServiceClient é instanciado lazily, só quando deps não é fornecido
  // (i.e. produção). Em testes, deps é sempre passado, evitando erro de
  // "supabaseUrl is required" sem .env.
  function buildDefaultDeps(): EstornarReservaDeps {
    const sb = createServiceClient();
    return {
      buscarLExistente: async (reserva_id) => {
        const { data } = await sb
          .from("siso_movimentacoes")
          .select("id")
          .eq("estorno_de", reserva_id)
          .eq("tipo", "L")
          .maybeSingle();
        return (data?.id as string | undefined) ?? null;
      },
      buscarReservaOriginal: async (reserva_id) => {
        const { data } = await sb
          .from("siso_movimentacoes")
          .select("produto_id, galpao_id, localizacao_id, quantidade, origem_id")
          .eq("id", reserva_id)
          .eq("tipo", "R")
          .maybeSingle();
        if (!data) return null;
        return {
          produto_id: data.produto_id as string,
          galpao_id: data.galpao_id as string,
          localizacao_id: data.localizacao_id as string,
          quantidade: Number(data.quantidade),
          origem_id: (data.origem_id as string | null) ?? null,
        };
      },
      inserirL: async ({ reserva_id, reserva, motivo, usuario_id }) => {
        const mov = await inserirMovimentacao({
          tripla: {
            produto_id: reserva.produto_id,
            galpao_id: reserva.galpao_id,
            localizacao_id: reserva.localizacao_id,
          },
          tipo: "L",
          qty: reserva.quantidade,
          origem_tipo: "liberacao_reserva",
          // EST-03 (b): propaga origem_id/pedido_id da R pro L — sem isso o L
          // ficava invisível pra guards que buscam liberação por pedido.
          origem_id: reserva.origem_id ?? undefined,
          origem_detalhes: { motivo },
          estorno_de: reserva_id,
          pedido_id: reserva.origem_id ?? undefined,
          usuario_id,
          motivo,
        });
        return mov.id;
      },
    };
  }

  const resolvedDeps: EstornarReservaDeps = deps ?? buildDefaultDeps();

  // Idempotência: L já existe?
  const lExistenteId = await resolvedDeps.buscarLExistente(input.reserva_id);
  if (lExistenteId) return lExistenteId;

  // Carrega a R original pra reconstruir tripla + qty
  const reserva = await resolvedDeps.buscarReservaOriginal(input.reserva_id);
  if (!reserva) {
    logger.warn("wms.reservas", "estorno: reserva original não encontrada", {
      reserva_id: input.reserva_id,
    });
    throw new Error(`Reserva ${input.reserva_id} não encontrada`);
  }

  return resolvedDeps.inserirL({
    reserva_id: input.reserva_id,
    reserva,
    motivo: `Estorno individual: ${input.motivo}`,
    usuario_id: input.usuario_id,
  });
}

interface ReservaExpirada {
  id: string;
  origem_id: string | null;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  quantidade: number;
}

/**
 * Cron de cleanup: libera reservas expiradas que ainda não foram liberadas.
 * Idempotente — pula reservas que já têm L apontando (estorno_de).
 *
 * Cobre duas origens de R com TTL:
 *  1. `reserva_pedido` (TTL 30d/48h) — reservas de pedido.
 *  2. `reserva_guarda` (TTL 7d) — reserva forte de put-away (P2-EST-04). Uma
 *     pendência de guarda abandonada deixava a R viva travando o `disponivel`
 *     pra sempre; aqui liberamos e regredimos a pendência pra `pendente`.
 */
export async function cleanupReservasExpiradas(): Promise<{
  total: number;
  liberadas: number;
  erros: number;
}> {
  const sb = createServiceClient();
  // P3-18: piso temporal — o cron não re-escaneia a história toda a cada hora.
  // R expiradas há mais de 60 dias são zumbis residuais que ficam pro relatório
  // de órfãs; o cleanup quente cobre só a janela recente (onde liberar ainda
  // importa pro disponível). 60 dias > TTL de 30d (reserva_pedido) com folga.
  const pisoTemporal = new Date(
    Date.now() - 60 * 24 * 3600 * 1000,
  ).toISOString();
  const { data: expiradas, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .lt("expira_em", new Date().toISOString())
    .gte("expira_em", pisoTemporal);
  if (error) throw error;

  const lista = (expiradas ?? []) as ReservaExpirada[];

  // EST-03 (a): guard POR RESERVA — L com estorno_de=R.id ⇒ R já liberada
  // (pick atômico, conversão pós-NF, estorno individual, resolver fantasma e
  // este próprio cron). Batch numa query só, em vez do antigo guard por
  // origem_id=pedido, que (1) não enxergava L individual sem origem_id →
  // double-release roubando reservado de outro pedido, e (2) pulava Rs
  // legítimas quando o pedido tinha QUALQUER L → reserva zumbi.
  const liberadasPorEstorno = new Set<string>();
  if (lista.length > 0) {
    const { data: ls, error: errLs } = await sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .eq("tipo", "L")
      .in("estorno_de", lista.map((r) => r.id));
    if (errLs) throw errLs;
    for (const l of ls ?? []) {
      if (l.estorno_de) liberadasPorEstorno.add(l.estorno_de as string);
    }
  }
  // Compat legado: liberarReserva (por pedido) e versões antigas deste cron
  // criaram L de liberacao_reserva SEM estorno_de — invisíveis ao guard acima.
  // Pra essas, mantém o skip por pedido, mas restrito a L sem estorno_de
  // (L de pick/pós-NF têm estorno_de e não bloqueiam mais Rs legítimas).
  const pedidosLiberados = new Set<string>();
  const pedidoIds = [
    ...new Set(lista.map((r) => r.origem_id).filter((x): x is string => !!x)),
  ];
  if (pedidoIds.length > 0) {
    const { data: lsPed, error: errPed } = await sb
      .from("siso_movimentacoes")
      .select("origem_id")
      .eq("tipo", "L")
      .eq("origem_tipo", "liberacao_reserva")
      .is("estorno_de", null)
      .in("origem_id", pedidoIds);
    if (errPed) throw errPed;
    for (const l of lsPed ?? []) {
      if (l.origem_id) pedidosLiberados.add(l.origem_id as string);
    }
  }

  let liberadas = 0;
  let erros = 0;
  for (const r of lista) {
    try {
      if (liberadasPorEstorno.has(r.id)) continue;
      if (r.origem_id && pedidosLiberados.has(r.origem_id)) continue;

      await inserirMovimentacao({
        tripla: {
          produto_id: r.produto_id,
          galpao_id: r.galpao_id,
          localizacao_id: r.localizacao_id,
        },
        tipo: "L",
        qty: Number(r.quantidade),
        origem_tipo: "liberacao_reserva",
        origem_id: r.origem_id ?? undefined,
        origem_detalhes: { motivo: "expirado" },
        // estorno_de torna a liberação rastreável POR RESERVA — é o que o
        // guard acima (e o uq_mov_estorno_unico) usam pra não liberar 2x.
        estorno_de: r.id,
        motivo: `expirado: reserva sem NF/cancelamento, pedido ${r.origem_id ?? "?"}`,
      });
      // Marca pedido com status_alerta se a tabela siso_pedidos suportar
      if (r.origem_id) {
        try {
          await sb
            .from("siso_pedidos")
            .update({ status_alerta: "reserva_expirada" })
            .eq("id", r.origem_id);
        } catch {
          // schema legado pode não ter status_alerta — ignora
        }
      }
      liberadas++;
    } catch (e) {
      logger.error("wms.reservas", "falha ao liberar expirada", {
        reserva: r.id,
        e: String(e),
      });
      erros++;
    }
  }

  // ── 2ª passada: R reserva_guarda expiradas (P2-EST-04) ────────────────────
  // Pendência de put-away abandonada deixa a reserva forte (TTL 7d) viva,
  // travando o `disponivel` da loc de recebimento pra sempre. Libera com L
  // (origem_tipo='liberacao_guarda', estorno_de=R.id, marca parcial=true) e
  // regride a pendência associada pra `pendente` quando ainda em_guarda.
  const guardaCleanup = await cleanupReservasGuardaExpiradas(sb, pisoTemporal);

  return {
    total: lista.length + guardaCleanup.total,
    liberadas: liberadas + guardaCleanup.liberadas,
    erros: erros + guardaCleanup.erros,
  };
}

/**
 * P2-EST-04: libera R `reserva_guarda` expiradas (TTL 7d) e regride a pendência
 * de guarda associada. Mesmo guard de vivacidade do cleanup de `reserva_pedido`:
 * pula R cujo net (SUM R - SUM L apontando via estorno_de) já é <= 0.
 *
 * O `origem_id` da R reserva_guarda é o `pendencia_id` (vide
 * wms_iniciar_guarda_atomico).
 */
async function cleanupReservasGuardaExpiradas(
  sb: ReturnType<typeof createServiceClient>,
  pisoTemporal: string,
): Promise<{ total: number; liberadas: number; erros: number }> {
  const { data: expiradas, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_guarda")
    .lt("expira_em", new Date().toISOString())
    .gte("expira_em", pisoTemporal);
  if (error) throw error;

  const lista = (expiradas ?? []) as ReservaExpirada[];
  if (lista.length === 0) return { total: 0, liberadas: 0, erros: 0 };

  // Guard de vivacidade em batch: soma das L que apontam (estorno_de) pra cada
  // R. Net = R.quantidade - SUM(L). Net <= 0 ⇒ R já 100% liberada → pula.
  const liberadoPorReserva = new Map<string, number>();
  const { data: ls, error: errLs } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de, quantidade")
    .eq("tipo", "L")
    .in(
      "estorno_de",
      lista.map((r) => r.id),
    );
  if (errLs) throw errLs;
  for (const l of ls ?? []) {
    const rid = l.estorno_de as string | null;
    if (!rid) continue;
    liberadoPorReserva.set(
      rid,
      (liberadoPorReserva.get(rid) ?? 0) + Number(l.quantidade ?? 0),
    );
  }

  let liberadas = 0;
  let erros = 0;
  for (const r of lista) {
    try {
      const jaLiberado = liberadoPorReserva.get(r.id) ?? 0;
      const residual = Number(r.quantidade) - jaLiberado;
      if (residual <= 0) continue; // net <= 0 → já liberada

      await inserirMovimentacao({
        tripla: {
          produto_id: r.produto_id,
          galpao_id: r.galpao_id,
          localizacao_id: r.localizacao_id,
        },
        tipo: "L",
        qty: residual,
        // `liberacao_guarda` é válido no CHECK do banco (20260609) mas o type
        // OrigemTipo (types.ts) ainda não lista as origens de guarda — cast
        // local até o type ser atualizado (gap conhecido).
        origem_tipo: "liberacao_guarda" as OrigemTipo,
        origem_id: r.origem_id ?? undefined,
        // parcial=true é OBRIGATÓRIO (convenção do uq_mov_estorno_unico
        // pós-20260611g) — uma R de guarda pode receber N liberações.
        origem_detalhes: { parcial: true, motivo: "ttl_expirado" },
        estorno_de: r.id,
        motivo: `reserva_guarda expirada (TTL): pendência ${r.origem_id ?? "?"}`,
      });

      // Regride a pendência associada (R.origem_id = pendencia_id).
      if (r.origem_id) {
        const { data: pend } = await sb
          .from("siso_wms_pendencias_guarda")
          .select("status")
          .eq("id", r.origem_id)
          .maybeSingle();
        const status = pend?.status as string | undefined;
        if (status === "em_guarda") {
          await sb
            .from("siso_wms_pendencias_guarda")
            .update({ status: "pendente", iniciada_por: null, iniciada_em: null })
            .eq("id", r.origem_id);
          logger.warn(
            "wms.reservas",
            "pendência de guarda regredida a 'pendente' por TTL da reserva forte",
            { pendencia_id: r.origem_id, reserva_id: r.id, qty: residual },
          );
        }
        // Status terminal (guardada/cancelada/encerrada_sem_saldo) ou pendente:
        // só liberamos a R, sem regredir.
      }
      liberadas++;
    } catch (e) {
      logger.error("wms.reservas", "falha ao liberar reserva_guarda expirada", {
        reserva: r.id,
        e: String(e),
      });
      erros++;
    }
  }
  return { total: lista.length, liberadas, erros };
}

/**
 * [P115] Libera reservas VENCIDAS de UMA localização (usado antes de desativar a
 * loc). Mesma lógica idempotente de cleanupReservasExpiradas, filtrada por loc.
 */
export async function cleanupReservasExpiradasDaLoc(localizacao_id: string): Promise<{ liberadas: number }> {
  const sb = createServiceClient();
  const { data: expiradas, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("localizacao_id", localizacao_id)
    .lt("expira_em", new Date().toISOString());
  if (error) throw error;
  const lista = (expiradas ?? []) as ReservaExpirada[];
  let liberadas = 0;
  for (const r of lista) {
    if (r.origem_id) {
      const { data: jaL } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .eq("origem_id", r.origem_id)
        .eq("tipo", "L")
        .limit(1);
      if (jaL && jaL.length > 0) continue;
    }
    await inserirMovimentacao({
      tripla: { produto_id: r.produto_id, galpao_id: r.galpao_id, localizacao_id: r.localizacao_id },
      tipo: "L",
      qty: Number(r.quantidade),
      origem_tipo: "liberacao_reserva",
      origem_id: r.origem_id ?? undefined,
      origem_detalhes: { motivo: "expirado_pre_desativacao" },
      // EST-03: rastreável por reserva — o guard do cron geral enxerga este L.
      estorno_de: r.id,
      motivo: `expirado (pré-desativação da loc): pedido ${r.origem_id ?? "?"}`,
    });
    liberadas++;
  }
  return { liberadas };
}

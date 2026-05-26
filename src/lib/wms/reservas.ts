import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import type { Tripla } from "./types";
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
  motivo: "rollback_aprovacao" | "outro";
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
  } | null>;
  /** Insere o L no ledger e retorna o id da mov criada. */
  inserirL: (params: {
    reserva_id: string;
    reserva: { produto_id: string; galpao_id: string; localizacao_id: string; quantidade: number };
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
          .select("produto_id, galpao_id, localizacao_id, quantidade")
          .eq("id", reserva_id)
          .eq("tipo", "R")
          .maybeSingle();
        if (!data) return null;
        return {
          produto_id: data.produto_id as string,
          galpao_id: data.galpao_id as string,
          localizacao_id: data.localizacao_id as string,
          quantidade: Number(data.quantidade),
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
          origem_detalhes: { motivo },
          estorno_de: reserva_id,
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
 * Idempotente — pula reservas que já têm L no mesmo pedido_id.
 */
export async function cleanupReservasExpiradas(): Promise<{
  total: number;
  liberadas: number;
  erros: number;
}> {
  const sb = createServiceClient();
  const { data: expiradas, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .lt("expira_em", new Date().toISOString());
  if (error) throw error;

  const lista = (expiradas ?? []) as ReservaExpirada[];
  let liberadas = 0;
  let erros = 0;
  for (const r of lista) {
    try {
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
  return { total: lista.length, liberadas, erros };
}

/**
 * Troca de Equivalência — integração com o ROTEAMENTO (Fase 4 do plano
 * 2026-06-12-cross-troca-equivalencia).
 *
 * Quando o galpão-casa não cobre um item com o SKU ORIGINAL, tenta cobrir com
 * SUBSTITUTO equivalente (cluster cross ∩ curadoria):
 *
 *   - mesmo tier + par verificado (regra 'livre')  → AUTO-TROCA: pedido segue
 *     'propria' (D10: troca local VENCE transferência), zero humano.
 *   - exige aprovação (tier difere / não verificado / sem tier) → pedido fica
 *     'pendente' com sugestao='troca_equivalente' + solicitação pendente com
 *     RESERVA FORTE no substituto (D6). Painel decide.
 *   - nenhum equivalente cobre → segue a rota original (transferência/OC).
 *
 * Sem ciclo de import: trocas-equivalencia.ts NÃO importa este arquivo — a
 * orquestração pós-decisão (aprovar pedido / re-rotear) é chamada pelas ROTAS.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";
import { inserirMovimentacao } from "./ledger";
import { reservarAtomico, estornarReservaIndividual } from "./reservas";
import {
  rotearPedidoDoBanco,
  TIPOS_LOC_VENDAVEIS,
  geoPriority,
  type GalpaoLite,
} from "./roteamento";
import { locsBloqueadasSet } from "./loc-locks";
import { kickWorker } from "@/lib/execution-worker";
import { listarEquivalentesComEstoque } from "./trocas-equivalencia";
import {
  regraTroca,
  type TierQualidade,
  type TrocaTipo,
} from "./trocas-equivalencia-regra";

const TTL_RESERVA_TROCA_HORAS = 48;

export interface ItemRotearTroca {
  tiny_id: string;
  sku: string;
  produto_uuid: string;
  qty: number;
}

export interface CoberturaOriginal {
  tiny_id: string;
  produto_uuid: string;
  qty: number;
  localizacao_id: string;
}

export interface SwapPlanejado {
  tiny_id: string;
  qty: number;
  produto_vendido_id: string;
  sku_vendido: string;
  produto_substituto_id: string;
  sku_substituto: string;
  localizacao_id: string;
  tipo: TrocaTipo;
  auto: boolean;
  tier_vendido: TierQualidade | null;
  tier_substituto: TierQualidade | null;
}

export interface PlanoTrocaRoteamento {
  cobertosOriginal: CoberturaOriginal[];
  swaps: SwapPlanejado[];
  /** true quando TODOS os swaps são 'livre' (auto) — pedido pode virar propria. */
  todosAuto: boolean;
}

/** Loc vendável (picking/overstock), não bloqueada, com disponivel >= qty. */
async function buscarLocQueCobre(
  produtoUuid: string,
  galpaoId: string,
  qty: number,
  bloqueadas: Set<string>,
): Promise<string | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_estoque")
    .select("localizacao_id, disponivel, siso_localizacoes!inner(tipo)")
    .eq("produto_id", produtoUuid)
    .eq("galpao_id", galpaoId)
    .in("siso_localizacoes.tipo", [...TIPOS_LOC_VENDAVEIS])
    .gte("disponivel", qty)
    .order("disponivel", { ascending: false })
    .limit(20);
  const livre = (data ?? []).find(
    (r) => !bloqueadas.has(r.localizacao_id as string),
  );
  return (livre?.localizacao_id as string | undefined) ?? null;
}

/**
 * Monta o plano de troca pro galpão-casa: itens cobertos pelo ORIGINAL +
 * swaps pra cada item descoberto. Retorna null se algum item descoberto não
 * tem substituto que cubra (plano não fecha → segue rota original).
 */
export async function planejarTrocaRoteamento(args: {
  galpaoId: string;
  itens: ItemRotearTroca[];
}): Promise<PlanoTrocaRoteamento | null> {
  const sb = createServiceClient();
  const bloqueadas = await locsBloqueadasSet(sb);

  const cobertosOriginal: CoberturaOriginal[] = [];
  const swaps: SwapPlanejado[] = [];

  for (const item of args.itens) {
    const locOriginal = await buscarLocQueCobre(
      item.produto_uuid,
      args.galpaoId,
      item.qty,
      bloqueadas,
    );
    if (locOriginal) {
      cobertosOriginal.push({
        tiny_id: item.tiny_id,
        produto_uuid: item.produto_uuid,
        qty: item.qty,
        localizacao_id: locOriginal,
      });
      continue;
    }

    const { data: vendido } = await sb
      .from("siso_produtos")
      .select("tier_qualidade")
      .eq("id", item.produto_uuid)
      .maybeSingle();
    const tierVendido =
      (vendido?.tier_qualidade as TierQualidade | null) ?? null;

    const equivalentes = await listarEquivalentesComEstoque({
      sku: item.sku,
      galpaoId: args.galpaoId,
    });

    // Candidatos avaliados pela regra; auto ('livre') primeiro, depois maior
    // disponível — maximiza chance do pedido sair sem humano.
    const avaliados = equivalentes
      .filter((e) => e.disponivel_galpao >= item.qty)
      .map((e) => ({
        e,
        regra: regraTroca({
          tierVendido,
          tierSubstituto: e.tier_qualidade,
          parVerificacao: e.par_verificacao,
          misto: false,
        }),
      }))
      .filter((c) => c.regra.resultado !== "bloqueada")
      .sort((a, b) => {
        const aAuto = a.regra.resultado === "livre" ? 0 : 1;
        const bAuto = b.regra.resultado === "livre" ? 0 : 1;
        if (aAuto !== bAuto) return aAuto - bAuto;
        return b.e.disponivel_galpao - a.e.disponivel_galpao;
      });

    let swap: SwapPlanejado | null = null;
    for (const { e, regra } of avaliados) {
      const loc = await buscarLocQueCobre(
        e.produto_id,
        args.galpaoId,
        item.qty,
        bloqueadas,
      );
      if (!loc) continue; // agregado cobre mas nenhuma loc única — segue (consistente com buscarLinha)
      swap = {
        tiny_id: item.tiny_id,
        qty: item.qty,
        produto_vendido_id: item.produto_uuid,
        sku_vendido: item.sku,
        produto_substituto_id: e.produto_id,
        sku_substituto: e.sku,
        localizacao_id: loc,
        tipo: regra.tipo as TrocaTipo,
        auto: regra.resultado === "livre",
        tier_vendido: tierVendido,
        tier_substituto: e.tier_qualidade,
      };
      break;
    }
    if (!swap) return null; // item sem cobertura nem com equivalente
    swaps.push(swap);
  }

  if (swaps.length === 0) return null; // nada a trocar (não deveria acontecer — caller só chama quando rota != propria)
  return {
    cobertosOriginal,
    swaps,
    todosAuto: swaps.every((s) => s.auto),
  };
}

/**
 * Galpões REMOTOS (≠ casa) ordenados por geo-priority em relação aos
 * preferenciais da empresa. Alimenta a troca remota.
 */
async function galpoesRemotosOrdenados(
  empresaId: string,
  galpaoCasaId: string,
): Promise<string[]> {
  const sb = createServiceClient();
  const { data: prefRows } = await sb
    .from("siso_empresa_galpoes_preferenciais")
    .select("galpao_id")
    .eq("empresa_id", empresaId);
  const prefIds = new Set((prefRows ?? []).map((r) => r.galpao_id as string));

  const { data: galpoes } = await sb
    .from("siso_galpoes")
    .select("id, cidade, estado")
    .eq("ativo", true);
  const lista = (galpoes ?? []) as GalpaoLite[];
  const homes = lista.filter((g) => prefIds.has(g.id));

  return lista
    .filter((g) => g.id !== galpaoCasaId)
    .sort((a, b) => geoPriority(a, homes) - geoPriority(b, homes))
    .map((g) => g.id);
}

/**
 * Troca REMOTA (nível 4 do roteamento): quando NEM o original NEM um equivalente
 * cobrem no galpão-casa (rota=oc), procura um galpão remoto onde TODOS os itens
 * fechem (original + equivalente), em ordem geo. Retorna o primeiro que cobre,
 * ou null. Reusa `planejarTrocaRoteamento` por galpão (single-galpão por pedido).
 *
 * Só deve ser chamado quando rota=oc — transferência (original em outro galpão,
 * nível 3) vence a troca remota (nível 4); troca local (nível 2) vence ambas.
 */
export async function planejarTrocaRemota(args: {
  empresaId: string;
  galpaoCasaId: string;
  itens: ItemRotearTroca[];
}): Promise<{ plano: PlanoTrocaRoteamento; galpaoId: string } | null> {
  const galpoes = await galpoesRemotosOrdenados(args.empresaId, args.galpaoCasaId);
  for (const g of galpoes) {
    const plano = await planejarTrocaRoteamento({ galpaoId: g, itens: args.itens });
    if (plano) return { plano, galpaoId: g };
  }
  return null;
}

/**
 * Aplica os swaps do plano nos itens recém-upsertados do pedido.
 *   - auto: cria a troca já 'aprovada' (system) + seta o substituto no item.
 *     A reserva do substituto é a R reserva_pedido criada pelo caller (rota).
 *   - aprovação: cria a troca 'pendente' + RESERVA FORTE (R reserva_troca,
 *     TTL 48h) na loc do plano (D6).
 */
export async function aplicarTrocasRoteamento(args: {
  pedidoId: string;
  galpaoId: string;
  swaps: SwapPlanejado[];
  /**
   * Troca remota: força TODA troca a 'pendente' + R reserva_troca (ignora
   * swap.auto). Remoto sempre exige aprovação humana (igual transferência).
   */
  forcarPendente?: boolean;
}): Promise<void> {
  const sb = createServiceClient();
  const source = "wms.trocas-roteamento";

  for (const swap of args.swaps) {
    const { data: item } = await sb
      .from("siso_pedido_itens")
      .select("id, produto_wms_substituto_id")
      .eq("pedido_id", args.pedidoId)
      .eq("produto_id", Number(swap.tiny_id))
      .maybeSingle();
    if (!item) {
      logger.warn(source, "item do swap não encontrado pós-upsert (pula)", {
        pedido_id: args.pedidoId,
        tiny_id: swap.tiny_id,
      });
      continue;
    }
    // Idempotência (re-entrega de webhook): auto já aplicado → skip.
    if (item.produto_wms_substituto_id) continue;

    // Remoto força pendente (aprovação humana), mesmo se a regra deu 'livre'.
    const ehAuto = swap.auto && !args.forcarPendente;

    const base = {
      pedido_id: args.pedidoId,
      pedido_item_id: item.id,
      galpao_id: args.galpaoId,
      produto_vendido_id: swap.produto_vendido_id,
      produto_substituto_id: swap.produto_substituto_id,
      sku_vendido: swap.sku_vendido,
      sku_substituto: swap.sku_substituto,
      quantidade: swap.qty,
      tipo: swap.tipo,
      origem_solicitacao: "roteamento",
      tier_vendido_snapshot: swap.tier_vendido,
      tier_substituto_snapshot: swap.tier_substituto,
    };

    if (ehAuto) {
      const { data: troca, error } = await sb
        .from("siso_trocas_equivalencia")
        .insert({ ...base, status: "aprovada", decidido_em: new Date().toISOString() })
        .select("id")
        .single();
      if (error || !troca) {
        throw new Error(`falha criando troca auto: ${error?.message}`);
      }
      const { error: upErr } = await sb
        .from("siso_pedido_itens")
        .update({
          produto_wms_substituto_id: swap.produto_substituto_id,
          troca_equivalencia_id: troca.id,
        })
        .eq("id", item.id);
      if (upErr) throw new Error(`falha aplicando substituto no item: ${upErr.message}`);

      registrarEvento({
        pedidoId: args.pedidoId,
        evento: "troca_auto_aplicada",
        detalhes: {
          troca_id: troca.id,
          sku_vendido: swap.sku_vendido,
          sku_substituto: swap.sku_substituto,
          quantidade: swap.qty,
          via: "roteamento",
        },
      }).catch(() => {});
    } else {
      const { data: troca, error } = await sb
        .from("siso_trocas_equivalencia")
        .insert({ ...base, status: "pendente" })
        .select("id")
        .single();
      if (error?.code === "23505") {
        // Idempotência: já existe troca pendente pra este item (re-entrega).
        continue;
      }
      if (error || !troca) {
        throw new Error(`falha criando troca pendente: ${error?.message}`);
      }
      const mov = await inserirMovimentacao({
        tripla: {
          produto_id: swap.produto_substituto_id,
          galpao_id: args.galpaoId,
          localizacao_id: swap.localizacao_id,
        },
        tipo: "R",
        qty: swap.qty,
        origem_tipo: "reserva_troca",
        origem_id: troca.id as string,
        origem_detalhes: {
          contexto: "roteamento",
          pedido_id: args.pedidoId,
          pedido_item_id: item.id,
        },
        expira_em: new Date(
          Date.now() + TTL_RESERVA_TROCA_HORAS * 3600 * 1000,
        ).toISOString(),
        pedido_id: args.pedidoId,
        motivo: `Reserva de troca (roteamento) ${swap.sku_vendido} → ${swap.sku_substituto}`,
      });
      await sb
        .from("siso_trocas_equivalencia")
        .update({ reserva_mov_ids: [mov.id] })
        .eq("id", troca.id);

      registrarEvento({
        pedidoId: args.pedidoId,
        evento: "troca_solicitada",
        detalhes: {
          troca_id: troca.id,
          sku_vendido: swap.sku_vendido,
          sku_substituto: swap.sku_substituto,
          tipo: swap.tipo,
          quantidade: swap.qty,
          via: "roteamento",
        },
      }).catch(() => {});
    }
  }
}

async function nomeGalpao(galpaoId: string): Promise<string | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from("siso_galpoes")
    .select("nome")
    .eq("id", galpaoId)
    .maybeSingle();
  return (data?.nome as string | null) ?? null;
}

/**
 * Aprova o PEDIDO (propria) depois que a última troca pendente de um pedido
 * sugestao='troca_equivalente' foi aprovada — mesma mecânica do painel:
 * RPC wms_aprovar_e_enfileirar (tudo-ou-nada) + kickWorker.
 *
 * Chamado pela ROTA de aprovar troca (não pelo serviço — evita ciclo).
 */
export async function aprovarPedidoPosTroca(args: {
  pedidoId: string;
  usuarioId: string;
  usuarioNome?: string | null;
}): Promise<{ aprovado: boolean; motivo?: string }> {
  const sb = createServiceClient();
  const source = "wms.trocas-roteamento";

  const { data: pedido } = await sb
    .from("siso_pedidos")
    .select(
      "id, status, sugestao, empresa_origem_id, separacao_galpao_id, nota_fiscal_id, chave_acesso_nf",
    )
    .eq("id", args.pedidoId)
    .maybeSingle();
  if (!pedido) return { aprovado: false, motivo: "pedido não encontrado" };
  if (pedido.status !== "pendente" || pedido.sugestao !== "troca_equivalente") {
    return { aprovado: false, motivo: `pedido em ${pedido.status}/${pedido.sugestao}` };
  }

  const { data: pendentes } = await sb
    .from("siso_trocas_equivalencia")
    .select("id")
    .eq("pedido_id", args.pedidoId)
    .eq("status", "pendente")
    .limit(1);
  if ((pendentes ?? []).length > 0) {
    return { aprovado: false, motivo: "ainda há trocas pendentes" };
  }

  const galpaoId = pedido.separacao_galpao_id as string | null;
  const galpao = galpaoId ? await nomeGalpao(galpaoId) : null;
  if (!galpaoId || !galpao) {
    return { aprovado: false, motivo: "pedido sem galpão de separação" };
  }

  const { error } = await sb.rpc("wms_aprovar_e_enfileirar", {
    p_pedido_id: args.pedidoId,
    p_decisao: "propria",
    p_status_separacao:
      pedido.nota_fiscal_id && pedido.chave_acesso_nf
        ? "aguardando_separacao"
        : "aguardando_nf",
    p_empresa_id: pedido.empresa_origem_id,
    p_filial_execucao: galpao,
    p_operador_id: args.usuarioId,
    p_operador_nome: args.usuarioNome ?? null,
    p_marcadores: [galpao, "LVR"],
    p_separacao_galpao_id: galpaoId,
  });
  if (error) {
    logger.error(source, "wms_aprovar_e_enfileirar falhou pós-troca", {
      pedido_id: args.pedidoId,
      error: error.message,
    });
    return { aprovado: false, motivo: error.message };
  }

  registrarEvento({
    pedidoId: args.pedidoId,
    evento: "aprovado",
    usuarioId: args.usuarioId,
    usuarioNome: args.usuarioNome ?? undefined,
    detalhes: { decisao: "propria", via: "troca_equivalente" },
  }).catch(() => {});

  kickWorker().catch((err) => {
    logger.error(source, "kickWorker falhou pós-troca", {
      pedido_id: args.pedidoId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return { aprovado: true };
}

/**
 * Re-roteia o pedido depois de uma troca de roteamento REJEITADA (D8):
 * libera as R reserva_pedido vivas, roda o roteamento de novo e aplica o
 * caminho normal (propria auto / transferencia pro painel / oc auto).
 */
export async function reRotearPedidoPosTroca(args: {
  pedidoId: string;
  usuarioId: string | null;
}): Promise<{ acao: "propria" | "transferencia" | "oc" | "nada" }> {
  const sb = createServiceClient();
  const source = "wms.trocas-roteamento";

  const { data: pedido } = await sb
    .from("siso_pedidos")
    .select(
      "id, status, sugestao, empresa_origem_id, separacao_galpao_id, nota_fiscal_id, chave_acesso_nf",
    )
    .eq("id", args.pedidoId)
    .maybeSingle();
  if (!pedido || pedido.status !== "pendente" || pedido.sugestao !== "troca_equivalente") {
    return { acao: "nada" };
  }

  // Ainda há outras trocas pendentes? Espera todas serem decididas.
  const { data: pendentes } = await sb
    .from("siso_trocas_equivalencia")
    .select("id")
    .eq("pedido_id", args.pedidoId)
    .eq("status", "pendente")
    .limit(1);
  if ((pendentes ?? []).length > 0) return { acao: "nada" };

  // 1. Libera R reserva_pedido vivas (cobertos-original + auto-swaps) — o
  //    re-roteamento lê `disponivel` e as R do próprio pedido o distorceriam.
  const { data: reservas } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", String(args.pedidoId));
  for (const r of reservas ?? []) {
    try {
      await estornarReservaIndividual({
        reserva_id: r.id as string,
        motivo: "outro",
        usuario_id: args.usuarioId ?? undefined,
      });
    } catch (e) {
      logger.warn(source, "falha estornando R no re-rotear (segue)", {
        reserva_id: r.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2. Itens (produto efetivo — auto-swaps aprovados permanecem)
  const { data: itens } = await sb
    .from("siso_pedido_itens")
    .select("produto_id, quantidade_pedida, produto_wms_substituto_id")
    .eq("pedido_id", args.pedidoId);
  const { data: mapeamentos } = await sb
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", pedido.empresa_origem_id as string)
    .in(
      "tiny_produto_id",
      (itens ?? []).map((i) => Number(i.produto_id)),
    );
  const uuidPorTiny = new Map(
    (mapeamentos ?? []).map((m) => [String(m.tiny_produto_id), m.produto_id as string]),
  );
  const itensPraRotear: Array<{ produto_id: string; qty: number }> = [];
  for (const i of itens ?? []) {
    const uuid =
      (i.produto_wms_substituto_id as string | null) ??
      uuidPorTiny.get(String(i.produto_id));
    if (!uuid) {
      logger.warn(source, "item sem mapeamento no re-rotear (pula)", {
        pedido_id: args.pedidoId,
        tiny_id: i.produto_id,
      });
      continue;
    }
    itensPraRotear.push({ produto_id: uuid, qty: Number(i.quantidade_pedida) });
  }

  const rota =
    itensPraRotear.length > 0
      ? await rotearPedidoDoBanco(pedido.empresa_origem_id as string, itensPraRotear)
      : ({ decisao: "oc", motivo: "sem_cobertura" } as const);

  // 3. Aplica o caminho normal
  if (rota.decisao === "propria" || rota.decisao === "transferencia") {
    if (rota.decisao === "propria") {
      // Reservas all-or-nothing + aprova (mesma semântica do webhook)
      const criadas: string[] = [];
      try {
        for (const r of rota.rotas) {
          const id = await reservarAtomico({
            tripla: {
              produto_id: r.produto_id,
              galpao_id: r.galpao_id,
              localizacao_id: r.localizacao_id,
            },
            qty: r.qty,
            pedido_id: String(args.pedidoId),
            ttl_horas: 24 * 30,
          });
          criadas.push(id);
        }
      } catch (e) {
        for (const rid of criadas) {
          await estornarReservaIndividual({ reserva_id: rid, motivo: "rollback_aprovacao" }).catch(
            () => {},
          );
        }
        throw e;
      }
      const galpao = await nomeGalpao(rota.galpao_id);
      const { error } = await sb.rpc("wms_aprovar_e_enfileirar", {
        p_pedido_id: args.pedidoId,
        p_decisao: "propria",
        p_status_separacao:
          pedido.nota_fiscal_id && pedido.chave_acesso_nf
            ? "aguardando_separacao"
            : "aguardando_nf",
        p_empresa_id: pedido.empresa_origem_id,
        p_filial_execucao: galpao,
        p_operador_id: args.usuarioId,
        p_operador_nome: null,
        p_marcadores: galpao ? [galpao, "LVR"] : ["LVR"],
        p_separacao_galpao_id: rota.galpao_id,
      });
      if (error) throw new Error(`aprovar pós re-rotear falhou: ${error.message}`);
      kickWorker().catch(() => {});
      return { acao: "propria" };
    }

    // transferencia → volta pro painel humano
    await sb
      .from("siso_pedidos")
      .update({
        sugestao: "transferencia",
        sugestao_motivo: "Re-roteado após troca rejeitada — estoque em outro galpão",
        separacao_galpao_id: rota.galpao_id,
      })
      .eq("id", args.pedidoId);
    return { acao: "transferencia" };
  }

  // oc → auto-aprova como o webhook faz
  const galpaoHomeId = pedido.separacao_galpao_id as string | null;
  const galpaoHome = galpaoHomeId ? await nomeGalpao(galpaoHomeId) : null;
  await sb
    .from("siso_pedidos")
    .update({
      sugestao: "oc",
      sugestao_motivo: "Re-roteado após troca rejeitada — sem cobertura, vai pra OC",
      decisao_final: "oc",
      status: "executando",
      tipo_resolucao: "auto",
      marcadores: galpaoHome ? ["OC", galpaoHome, "LVR"] : ["OC", "LVR"],
    })
    .eq("id", args.pedidoId);

  const { data: jobExistente } = await sb
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", args.pedidoId)
    .eq("tipo", "lancar_estoque")
    .in("status", ["pendente", "executando"])
    .maybeSingle();
  if (!jobExistente) {
    await sb.from("siso_fila_execucao").insert({
      pedido_id: args.pedidoId,
      tipo: "lancar_estoque",
      filial_execucao: galpaoHome,
      empresa_id: pedido.empresa_origem_id,
      decisao: "oc",
    });
  }
  kickWorker().catch(() => {});
  return { acao: "oc" };
}

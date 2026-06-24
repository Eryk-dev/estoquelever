/**
 * tiny-polling-futura — descobre vendas ML com etiqueta segurada (buffered) e
 * as carrega na pista de separação futura.
 *
 * Problema: uma venda paga cuja etiqueta o ML segura pra data futura fica presa
 * no Tiny em situacao "em aberto" e NÃO dispara o webhook (o Tiny só dispara
 * quando o pedido avança). O app fica cego pra ela até a etiqueta liberar —
 * tarde demais pra comprar com lead time.
 *
 * Solução: varre os pedidos ABERTOS do Tiny (fallback, igual ao poll de
 * aprovados), e pra cada pedido ML lê o `shipment.substatus` no ML
 * (getMlShipmentStatus). `buffered` → carrega como futura (processWebhook com
 * separacaoFutura=true): reserva estoque, separa, compra — SEM gerar NF.
 *
 * Cadência separada do poll normal (ML-heavy) — via /api/wms/tiny/polling-futura
 * (pg_cron ~30min). Dedup por siso_pedidos (futura já carregada) + dedup_key do
 * webhook log (tiny_id:polling_futura:buffered).
 */

import { createServiceClient } from "./supabase-server";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { listarPedidos, type TinyPedidoListItem } from "./tiny-api";
import { getEmpresaByCnpj, type EmpresaInfo } from "./empresa-lookup";
import { processWebhook } from "./webhook-processor";
import { getActiveMlConnectionForEmpresa, getMlShipmentStatus } from "./ml-api";
import { isMercadoLivre } from "./domain-helpers";
import { SUBSTATUS_FUTURA } from "./wms/separacao-futura";
import { chunk, listarTodasPaginas } from "./tiny-polling";
import { logger } from "./logger";

const LOG_SOURCE = "tiny-polling-futura";
// Tiny situacao "Em aberto" — pedido pago mas ainda não avançado (etiqueta
// segurada). ⚠ CONFIRMAR o código exato no build (observado buffered=0). A
// VERDADE da classificação futura×agora é o ML substatus; o situacao do Tiny é
// só o filtro grosso da listagem.
const SITUACAO_PEDIDO_ABERTA = 0;
const PAGE_LIMIT = 100;
const DIAS_JANELA = 7;
// Cap de lookups ML por empresa por run: protege o rate-limit do ML. Open
// orders ML NÃO-buffered não viram pedido (não há onde dedup-ar) → seriam
// re-checados a cada run; o cap bordeia isso e o backlog drena em runs
// sucessivos. Truncamento é logado (sem corte silencioso).
const FUTURA_ML_CHECK_MAX = 50;

function dataInicialJanela(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export interface FuturaPollResumoEmpresa {
  empresa_id: string;
  empresa_nome: string;
  cnpj: string;
  abertos_vistos: number;
  ml_consultados: number;
  buffered_detectados: number;
  futura_processados: number;
  truncado: boolean;
  erros: string[];
}

export interface FuturaPollResult {
  janela_dias: number;
  empresas: FuturaPollResumoEmpresa[];
  executado_em: string;
}

async function sweepFuturaEmpresa(
  token: string,
  empresa: EmpresaInfo,
  cnpj: string,
  dataInicial: string,
  resumo: FuturaPollResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();

  const connId = await getActiveMlConnectionForEmpresa(empresa.empresaId);
  if (!connId) return; // empresa sem conexão ML → não há buffered a classificar

  const abertos = await listarTodasPaginas<TinyPedidoListItem>((offset) =>
    listarPedidos(token, {
      situacao: SITUACAO_PEDIDO_ABERTA,
      dataInicial,
      limit: PAGE_LIMIT,
      offset,
    }),
  );
  resumo.abertos_vistos = abertos.length;
  if (abertos.length === 0) return;

  // Só pedidos ML com order/pack id (o classificador precisa dele).
  const porId = new Map<string, TinyPedidoListItem>();
  for (const p of abertos) {
    if (
      p?.id != null &&
      isMercadoLivre(p.ecommerce?.nome) &&
      p.ecommerce?.numeroPedidoEcommerce
    ) {
      porId.set(String(p.id), p);
    }
  }
  const ids = [...porId.keys()];
  if (ids.length === 0) return;

  // Dedup: pula o que já existe em siso_pedidos (qualquer estado — inclui futura
  // já carregada). A re-detecção no intake (processWebhookWms 4b-futura) é a 2ª
  // rede; aqui evitamos a chamada ML pra pedidos já conhecidos.
  const existentes = new Set<string>();
  for (const lote of chunk(ids, 200)) {
    const { data } = await sb.from("siso_pedidos").select("id").in("id", lote);
    for (const r of (data ?? []) as Array<{ id: string }>) existentes.add(r.id);
  }
  const candidatos = ids.filter((id) => !existentes.has(id));
  if (candidatos.length === 0) return;

  let consultados = 0;
  for (const tinyId of candidatos) {
    if (consultados >= FUTURA_ML_CHECK_MAX) {
      resumo.truncado = true;
      logger.warn(LOG_SOURCE, "cap de lookups ML atingido — restante drena no próximo run", {
        empresaId: empresa.empresaId,
        restantes: candidatos.length - consultados,
      });
      break;
    }
    const item = porId.get(tinyId)!;
    const mlOrderId = item.ecommerce!.numeroPedidoEcommerce!;
    try {
      consultados++;
      const st = await getMlShipmentStatus(connId, mlOrderId);
      // Só buffered entra na pista futura. ready_to_print/outros: o fluxo normal
      // pega quando o pedido aprovar (poll de aprovados / webhook).
      if (st?.substatus !== SUBSTATUS_FUTURA) continue;
      resumo.buffered_detectados++;

      const { data: logEntry, error: insErr } = await sb
        .from("siso_webhook_logs")
        .insert({
          tiny_pedido_id: tinyId,
          cnpj,
          tipo: "polling_futura",
          codigo_situacao: "buffered",
          filial: empresa.galpaoNome,
          empresa_id: empresa.empresaId,
          payload: {
            origem: "polling_futura",
            substatus: st.substatus,
            shipmentId: st.shipmentId,
            dados: item,
          },
        })
        .select("id")
        .single();

      if (insErr) {
        // 23505 = dedup_key (tiny_id:polling_futura:buffered) já existe → já
        // processado/em voo num run anterior. Idempotente, pula.
        if (insErr.code === "23505") continue;
        resumo.erros.push(`pedido ${tinyId}: ${insErr.message}`);
        continue;
      }

      await processWebhook(
        logEntry.id,
        tinyId,
        empresa.empresaId,
        empresa.galpaoId,
        empresa.grupoId,
        true, // separacaoFutura
      );
      resumo.futura_processados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`pedido ${tinyId}: ${msg}`);
      logger.warn(LOG_SOURCE, "Falha processando futura via polling (segue)", {
        tinyId,
        empresaId: empresa.empresaId,
        error: msg,
      });
    }
  }
  resumo.ml_consultados = consultados;
}

/**
 * Varre as contas Tiny conectadas atrás de vendas ML buffered e as carrega na
 * pista futura. Erros isolados por empresa e por pedido.
 */
export async function pollTinyFutura(): Promise<FuturaPollResult> {
  const sb = createServiceClient();
  const dataInicial = dataInicialJanela(DIAS_JANELA);

  const { data: connections, error } = await sb
    .from("siso_tiny_connections")
    .select("cnpj, empresa_id")
    .eq("ativo", true)
    .not("empresa_id", "is", null)
    .not("access_token", "is", null);
  if (error) throw new Error(`Falha listando conexões Tiny: ${error.message}`);

  const { data: empresasAtivas, error: empErr } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true);
  if (empErr) throw new Error(`Falha listando empresas ativas: ${empErr.message}`);
  const ativasSet = new Set(
    (empresasAtivas ?? []).map((e) => (e as { id: string }).id),
  );

  const conns = ((connections ?? []) as Array<{ cnpj: string; empresa_id: string }>).filter(
    (c) => ativasSet.has(c.empresa_id),
  );

  const result: FuturaPollResult = {
    janela_dias: DIAS_JANELA,
    empresas: [],
    executado_em: new Date().toISOString(),
  };

  for (const conn of conns) {
    const resumo: FuturaPollResumoEmpresa = {
      empresa_id: conn.empresa_id,
      empresa_nome: "",
      cnpj: conn.cnpj,
      abertos_vistos: 0,
      ml_consultados: 0,
      buffered_detectados: 0,
      futura_processados: 0,
      truncado: false,
      erros: [],
    };
    result.empresas.push(resumo);

    try {
      const empresa = await getEmpresaByCnpj(conn.cnpj);
      if (!empresa) {
        resumo.erros.push("empresa não encontrada/inativa pra esse CNPJ");
        continue;
      }
      resumo.empresa_nome = empresa.empresaNome;

      const { token } = await getValidTokenByEmpresa(empresa.empresaId);
      await runWithEmpresa(empresa.empresaId, () =>
        sweepFuturaEmpresa(token, empresa, conn.cnpj, dataInicial, resumo),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(msg);
      logger.logError({
        error: err,
        source: LOG_SOURCE,
        message: `Polling futura falhou pra empresa ${conn.empresa_id}`,
        category: "external_api",
        empresaId: conn.empresa_id,
        metadata: { cnpj: conn.cnpj },
      });
    }
  }

  logger.info(LOG_SOURCE, "Polling futura concluído", {
    empresas: result.empresas.length,
    futura_processados: result.empresas.reduce((s, e) => s + e.futura_processados, 0),
  });
  return result;
}

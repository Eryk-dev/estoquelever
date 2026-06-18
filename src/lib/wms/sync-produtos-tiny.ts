/**
 * Sync incremental do catálogo de produtos do Tiny → SISO.
 *
 * O cron `wms_tiny_sync_produtos` (pg_cron, 1 min) chama
 * GET /api/wms/tiny/sync-produtos, que invoca `sincronizarProdutosRecentes()`.
 *
 * A cada rodada, varre TODAS as contas Tiny conectadas (mesmo conjunto do
 * polling de pedidos: conexão ativa + empresa ativa) e busca em /produtos os
 * itens criados OU alterados nos últimos `lookbackMin` minutos (default 2).
 * A janela de 2 min > cadência de 1 min cobre o minuto anterior inteiro mesmo
 * com skew de relógio; a sobreposição entre rodadas é inofensiva porque o
 * upsert é idempotente (sku é UNIQUE em siso_produtos).
 *
 * Para cada produto recente:
 *   - já existe no catálogo (por SKU) → garante a ponte tiny→wms desta empresa
 *     + `sincronizarProduto` (refresh de descrição, NCM, GTIN, unidade, origem
 *     fiscal, imagens, fornecedores, kit).
 *   - novo → `ensureProdutoFromTiny` (cria + ponte + sincroniza).
 *
 * Estoque NÃO é tocado: o WMS é a fonte única de estoque (3D); o Tiny é só
 * camada fiscal/marketplace. Este sync é catálogo/metadata apenas.
 *
 * Erros são isolados por empresa e por produto — uma falha não derruba o resto.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { listarProdutos, type TinyProdutoListItem } from "@/lib/tiny-api";
import { ensureProdutoFromTiny, sincronizarProduto } from "@/lib/wms/sync-tiny";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "wms.sync-produtos";
const LOOKBACK_MIN_DEFAULT = 2;
const PAGE_LIMIT = 100;
// Teto de páginas por varredura. Com o filtro de data por minuto a resposta é
// pequena (≤1 página no caso normal); o teto só protege contra um dia inteiro
// de produtos caso o Tiny ignore a hora do filtro e trate só o dia.
const MAX_PAGES = 20;

export interface SyncProdutosResumoEmpresa {
  empresa_id: string;
  cnpj: string;
  vistos: number;
  criados: number;
  atualizados: number;
  erros: string[];
}

export interface SyncProdutosResult {
  lookback_min: number;
  cutoff: string;
  empresas: SyncProdutosResumoEmpresa[];
  executado_em: string;
}

/**
 * Cutoff `YYYY-MM-DD HH:MM:SS` em America/Sao_Paulo (TZ do Tiny). O polling de
 * pedidos usa só o dia (UTC), o que serve pra janelas de 7-30 dias; aqui a
 * janela é de minutos, então a precisão de hora + TZ correta é obrigatória.
 */
function cutoffBRT(minAgo: number): string {
  const d = new Date(Date.now() - minAgo * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Filtro defensivo: só DESCARTA um item se conseguirmos provar que é antigo
 * (formato de data reconhecido E nenhuma das datas >= cutoff). Formato
 * inesperado / sem data → mantém (errar pra incluir, nunca perder). Compara
 * string a string: ambos os lados estão em BRT no mesmo formato sortável.
 */
function pareceRecente(it: TinyProdutoListItem, cutoff: string): boolean {
  const datas = [it.dataCriacao, it.dataAlteracao]
    .filter((s): s is string => !!s)
    .map((s) => s.replace("T", " ").slice(0, 19))
    .filter((s) => /^\d{4}-\d{2}-\d{2}/.test(s));
  if (datas.length === 0) return true;
  return datas.some((d) => d >= cutoff);
}

/**
 * Coleta os produtos recentes de UMA empresa (token já resolvido, dentro de
 * runWithEmpresa). Varre as duas datas (criação + alteração) e une por id.
 */
async function coletarRecentes(
  token: string,
  cutoff: string,
): Promise<Map<number, TinyProdutoListItem>> {
  const alvos = new Map<number, TinyProdutoListItem>();
  const campos: Array<"dataCriacao" | "dataAlteracao"> = [
    "dataCriacao",
    "dataAlteracao",
  ];
  for (const campo of campos) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listarProdutos(token, {
        situacao: "A",
        [campo]: cutoff,
        limit: PAGE_LIMIT,
        offset,
      });
      const itens = res.itens ?? [];
      for (const it of itens) {
        if (it.id == null) continue;
        if (pareceRecente(it, cutoff)) alvos.set(it.id, it);
      }
      if (itens.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
      if (page === MAX_PAGES - 1) {
        logger.warn(
          LOG_SOURCE,
          "MAX_PAGES atingido na varredura — possível truncamento",
          { campo, cutoff },
        );
      }
    }
  }
  return alvos;
}

/**
 * Aplica um produto recente no catálogo. Retorna o que aconteceu.
 * Roda dentro de runWithEmpresa (sincronizarProduto/ensureProdutoFromTiny
 * chamam o Tiny pra puxar o detalhe completo).
 */
async function aplicarProduto(
  sb: ReturnType<typeof createServiceClient>,
  empresaId: string,
  item: TinyProdutoListItem,
): Promise<"criado" | "atualizado" | "ignorado"> {
  const sku = item.sku?.trim();
  // siso_produtos.sku é NOT NULL UNIQUE — produto sem SKU não entra no catálogo.
  if (!sku) return "ignorado";

  const { data: existente } = await sb
    .from("siso_produtos")
    .select("id")
    .eq("sku", sku)
    .maybeSingle();

  if (existente) {
    await sb.from("siso_produto_empresas").upsert(
      {
        produto_id: existente.id,
        empresa_id: empresaId,
        tiny_produto_id: item.id,
      },
      { onConflict: "produto_id,empresa_id" },
    );
    await sincronizarProduto(existente.id, { preferEmpresaId: empresaId });
    return "atualizado";
  }

  await ensureProdutoFromTiny(sku, empresaId, item.id);
  return "criado";
}

/**
 * Ponto de entrada do sync incremental. Varre todas as contas conectadas e
 * sincroniza os produtos criados/alterados na janela.
 */
export async function sincronizarProdutosRecentes(
  opts: { lookbackMin?: number } = {},
): Promise<SyncProdutosResult> {
  const lookbackMin = opts.lookbackMin ?? LOOKBACK_MIN_DEFAULT;
  const cutoff = cutoffBRT(lookbackMin);
  const sb = createServiceClient();

  const { data: connections, error } = await sb
    .from("siso_tiny_connections")
    .select("cnpj, empresa_id")
    .eq("ativo", true)
    .not("empresa_id", "is", null)
    .not("access_token", "is", null);
  if (error) throw new Error(`Falha listando conexões Tiny: ${error.message}`);

  // Empresa desativada = pulada (mesma regra do polling/webhook).
  const { data: empresasAtivas, error: empErr } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true);
  if (empErr) throw new Error(`Falha listando empresas ativas: ${empErr.message}`);
  const ativas = new Set(
    (empresasAtivas ?? []).map((e) => (e as { id: string }).id),
  );

  const conns = (
    (connections ?? []) as Array<{ cnpj: string; empresa_id: string }>
  ).filter((c) => ativas.has(c.empresa_id));

  const result: SyncProdutosResult = {
    lookback_min: lookbackMin,
    cutoff,
    empresas: [],
    executado_em: new Date().toISOString(),
  };

  for (const conn of conns) {
    const resumo: SyncProdutosResumoEmpresa = {
      empresa_id: conn.empresa_id,
      cnpj: conn.cnpj,
      vistos: 0,
      criados: 0,
      atualizados: 0,
      erros: [],
    };
    result.empresas.push(resumo);

    try {
      const { token } = await getValidTokenByEmpresa(conn.empresa_id);
      // runWithEmpresa: rate-limit + contexto pro stub (gotcha #8).
      await runWithEmpresa(conn.empresa_id, async () => {
        const alvos = await coletarRecentes(token, cutoff);
        resumo.vistos = alvos.size;
        for (const item of alvos.values()) {
          try {
            const r = await aplicarProduto(sb, conn.empresa_id, item);
            if (r === "criado") resumo.criados++;
            else if (r === "atualizado") resumo.atualizados++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            resumo.erros.push(`produto ${item.sku ?? item.id}: ${msg}`);
            logger.warn(LOG_SOURCE, "falha sincronizando produto (segue)", {
              empresaId: conn.empresa_id,
              tinyId: item.id,
              sku: item.sku,
              error: msg,
            });
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(msg);
      logger.logError({
        error: err,
        source: LOG_SOURCE,
        message: "Sync de produtos falhou pra empresa",
        category: "external_api",
        empresaId: conn.empresa_id,
        metadata: { cnpj: conn.cnpj },
      });
    }
  }

  return result;
}

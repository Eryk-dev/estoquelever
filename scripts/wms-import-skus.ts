// One-off: importa todos os SKUs ativos (tipo=produto, sem kits) das empresas
// conectadas no Tiny pro catálogo unificado do WMS (siso_produtos +
// siso_produto_empresas). Idempotente — não sobrescreve descrições existentes.
//
// Tokens lidos de /tmp/wms-import/{nome}.token (texto plano, fora do repo).
//
// Uso:
//   npx tsx scripts/wms-import-skus.ts                 # roda tudo
//   npx tsx scripts/wms-import-skus.ts --empresa NetAir
//   npx tsx scripts/wms-import-skus.ts --max-pages 3   # smoke test

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createServiceClient } from "../src/lib/supabase-server";

interface EmpresaCfg {
  id: string;
  nome: string;
  tokenFile: string;
}

const EMPRESAS: EmpresaCfg[] = [
  {
    id: "4473ca97-67e7-44e5-a192-ec756146b691",
    nome: "NetAir",
    tokenFile: "/tmp/wms-import/netair.token",
  },
  {
    id: "c27d85ce-e469-42dc-ae0f-10b722fa5b37",
    nome: "NetParts",
    tokenFile: "/tmp/wms-import/netparts.token",
  },
];

interface TinyListItem {
  id: number;
  sku: string;
  descricao: string;
  tipo: string;
  situacao: string;
}

interface TinyListResponse {
  itens: TinyListItem[];
  paginacao: { limit: number; offset: number; total: number };
}

async function tinyList(
  token: string,
  offset: number,
  limit: number,
): Promise<TinyListResponse> {
  const url = `https://api.tiny.com.br/public-api/v3/produtos?tipo=produto&situacao=A&limit=${limit}&offset=${offset}`;
  // Retry on 429 with exponential backoff.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 429) {
      const wait = Math.min(2000 * 2 ** attempt, 15000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Tiny GET produtos ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as TinyListResponse;
  }
  throw new Error("Tiny GET produtos: 429 exausto");
}

interface BatchStats {
  pagina: number;
  recebidos: number;
  produtosNovos: number;
  produtosExistentes: number;
  mappingsCriados: number;
}

async function processarLote(
  empresa: EmpresaCfg,
  itens: TinyListItem[],
  pagina: number,
): Promise<BatchStats> {
  const sb = createServiceClient();

  // Dedupe por SKU dentro do mesmo lote (Tiny pode retornar SKUs vazios ou
  // repetidos em casos raros — protege o upsert).
  const porSku = new Map<string, TinyListItem>();
  for (const it of itens) {
    const sku = (it.sku ?? "").trim();
    if (!sku) continue;
    if (!porSku.has(sku)) porSku.set(sku, it);
  }
  const unicos = [...porSku.values()];

  // 1) INSERT ... ON CONFLICT (sku) DO NOTHING — preserva descrição existente.
  // supabase-js: upsert com ignoreDuplicates não retorna as linhas que já
  // existiam, então faz separado: INSERT só os novos + SELECT pra ter ids.
  const skus = unicos.map((u) => u.sku);

  const { data: existentes, error: errSel } = await sb
    .from("siso_produtos")
    .select("id, sku")
    .in("sku", skus);
  if (errSel) throw errSel;

  const idPorSku = new Map<string, string>(
    (existentes ?? []).map((r: { id: string; sku: string }) => [r.sku, r.id]),
  );

  const novos = unicos
    .filter((u) => !idPorSku.has(u.sku))
    .map((u) => ({
      sku: u.sku,
      // descricao é NOT NULL; usa o que veio do Tiny ou fallback.
      descricao: (u.descricao && u.descricao.trim()) || `(sem descricao) ${u.sku}`,
    }));

  let produtosNovos = 0;
  if (novos.length > 0) {
    const { data: inseridos, error: errIns } = await sb
      .from("siso_produtos")
      .upsert(novos, { onConflict: "sku", ignoreDuplicates: true })
      .select("id, sku");
    if (errIns) throw errIns;
    for (const r of inseridos ?? []) {
      idPorSku.set(r.sku, r.id);
    }
    produtosNovos = (inseridos ?? []).length;

    // Edge case: se `ignoreDuplicates: true` engoliu retorno de linhas
    // que conflitaram (race com outro processo), pega os ids que faltarem.
    const semId = novos.filter((n) => !idPorSku.has(n.sku)).map((n) => n.sku);
    if (semId.length > 0) {
      const { data: extras } = await sb
        .from("siso_produtos")
        .select("id, sku")
        .in("sku", semId);
      for (const r of extras ?? []) {
        idPorSku.set(r.sku, r.id);
      }
    }
  }

  // 2) UPSERT siso_produto_empresas com tiny_produto_id atualizado.
  const mappings = unicos
    .map((u) => {
      const produto_id = idPorSku.get(u.sku);
      if (!produto_id) return null;
      return {
        produto_id,
        empresa_id: empresa.id,
        tiny_produto_id: u.id,
        ativo: true,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  let mappingsCriados = 0;
  if (mappings.length > 0) {
    const { error: errMap, count } = await sb
      .from("siso_produto_empresas")
      .upsert(mappings, {
        onConflict: "produto_id,empresa_id",
        count: "exact",
      });
    if (errMap) throw errMap;
    mappingsCriados = count ?? mappings.length;
  }

  return {
    pagina,
    recebidos: itens.length,
    produtosNovos,
    produtosExistentes: unicos.length - produtosNovos,
    mappingsCriados,
  };
}

async function processarEmpresa(
  empresa: EmpresaCfg,
  maxPages: number,
): Promise<void> {
  const token = (await readFile(empresa.tokenFile, "utf-8")).trim();
  console.log(`\n[${empresa.nome}] iniciando (token ${token.length} chars)…`);

  const limit = 100;
  let offset = 0;
  let total = -1;
  let pagina = 0;
  let acumRecebidos = 0;
  let acumNovos = 0;
  let acumMappings = 0;

  while (true) {
    pagina++;
    if (maxPages > 0 && pagina > maxPages) {
      console.log(`[${empresa.nome}] --max-pages atingido (${maxPages})`);
      break;
    }

    let page: TinyListResponse;
    try {
      page = await tinyList(token, offset, limit);
    } catch (e) {
      console.error(
        `[${empresa.nome}] erro p${pagina} off=${offset}: ${(e as Error).message}`,
      );
      throw e;
    }

    if (total < 0) {
      total = page.paginacao.total;
      console.log(`[${empresa.nome}] total esperado: ${total}`);
    }

    if (!page.itens.length) {
      console.log(`[${empresa.nome}] página vazia, fim`);
      break;
    }

    const stats = await processarLote(empresa, page.itens, pagina);
    acumRecebidos += stats.recebidos;
    acumNovos += stats.produtosNovos;
    acumMappings += stats.mappingsCriados;

    const pct = total > 0 ? ((acumRecebidos / total) * 100).toFixed(1) : "?";
    console.log(
      `[${empresa.nome}] p${pagina} off=${offset} recv=${stats.recebidos} novo=${stats.produtosNovos} map=${stats.mappingsCriados} | acum ${acumRecebidos}/${total} (${pct}%)`,
    );

    if (page.itens.length < limit) {
      console.log(`[${empresa.nome}] última página (${page.itens.length}<${limit})`);
      break;
    }
    offset += limit;

    // 55 req/min = ~1.09s/req. Espera 200ms entre páginas (somando latência
    // da Tiny já dá ~1s); tiny-queue da app vai cuidar quando rodar em prod.
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(
    `[${empresa.nome}] CONCLUÍDO: ${acumRecebidos} recebidos, ${acumNovos} produtos novos, ${acumMappings} mappings upsert`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filtroIdx = args.indexOf("--empresa");
  const filtroNome =
    filtroIdx >= 0 ? args[filtroIdx + 1]?.toLowerCase() : undefined;
  const maxPagesIdx = args.indexOf("--max-pages");
  const maxPages =
    maxPagesIdx >= 0 ? parseInt(args[maxPagesIdx + 1] ?? "0", 10) || 0 : 0;

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  console.log(`destino: ${supaUrl}`);
  if (!supaUrl.includes("ehbxpbeijofxtsbezwxd")) {
    console.warn(
      `⚠ destino NÃO é staging (esperado ehbxpbeijofxtsbezwxd). Confirme antes de seguir.`,
    );
  }

  const lista = filtroNome
    ? EMPRESAS.filter((e) => e.nome.toLowerCase() === filtroNome)
    : EMPRESAS;
  if (lista.length === 0) {
    throw new Error(`Nenhuma empresa casou com filtro: ${filtroNome}`);
  }

  for (const empresa of lista) {
    await processarEmpresa(empresa, maxPages);
  }

  // Resumo final no destino.
  const sb = createServiceClient();
  const { count: produtosTotal } = await sb
    .from("siso_produtos")
    .select("*", { count: "exact", head: true });
  const { count: mappingsTotal } = await sb
    .from("siso_produto_empresas")
    .select("*", { count: "exact", head: true });
  console.log(
    `\n[final] siso_produtos=${produtosTotal} | siso_produto_empresas=${mappingsTotal}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

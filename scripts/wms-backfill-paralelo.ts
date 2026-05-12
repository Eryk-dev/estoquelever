// Backfill paralelo de imagens + fornecedores + composição de kit pra todos
// os produtos sem imagens. Splita o trabalho entre NetAir + NetParts de modo
// determinístico (sem race em SKUs compartilhados) e roda as duas filas em
// paralelo via Promise.all.
//
// Regras de split (decididas no momento do split, não em tempo de processamento):
//   - Produto mapeado SÓ em NetAir → fila NetAir
//   - Produto mapeado SÓ em NetParts → fila NetParts
//   - Produto mapeado em AMBOS → hash(produto_id) % 2 → 0=NetAir, 1=NetParts
//
// Uso:
//   npx tsx scripts/wms-backfill-paralelo.ts                # roda tudo
//   npx tsx scripts/wms-backfill-paralelo.ts --limit 50     # smoke test
//   npx tsx scripts/wms-backfill-paralelo.ts --force        # ignora imagens existentes

import "dotenv/config";
import { createHash } from "node:crypto";
import { createServiceClient } from "../src/lib/supabase-server";
import { sincronizarProduto } from "../src/lib/wms/sync-tiny";

const NETAIR_ID = "4473ca97-67e7-44e5-a192-ec756146b691";
const NETPARTS_ID = "c27d85ce-e469-42dc-ae0f-10b722fa5b37";

interface ProdutoComMapping {
  id: string;
  sku: string;
  empresas: Set<string>;
}

async function carregarLista(
  force: boolean,
  limit: number,
): Promise<ProdutoComMapping[]> {
  const sb = createServiceClient();
  // 1) Produtos elegíveis (imagens vazias se !force, ou todos se force).
  // Supabase tem cap default de 1000 — paginamos com range pra pegar tudo.
  const lista: Array<{ id: string; sku: string }> = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const ate = offset + PAGE - 1;
    let qBase = sb
      .from("siso_produtos")
      .select("id, sku")
      .eq("ativo", true)
      .order("sku", { ascending: true })
      .range(offset, ate);
    if (!force) qBase = qBase.eq("imagens", "{}");
    const { data, error } = await qBase;
    if (error) throw error;
    const batch = (data ?? []) as Array<{ id: string; sku: string }>;
    lista.push(...batch);
    if (batch.length < PAGE) break;
    if (limit > 0 && lista.length >= limit) {
      lista.splice(limit);
      break;
    }
    offset += PAGE;
  }
  if (lista.length === 0) return [];

  // 2) Mapping empresa → produto (em chunks pra não estourar URL).
  const ids = lista.map((p) => p.id);
  const idsPorChunk = chunk(ids, 200);
  const empresasPorProduto = new Map<string, Set<string>>();

  for (const idsChunk of idsPorChunk) {
    const { data: maps } = await sb
      .from("siso_produto_empresas")
      .select("produto_id, empresa_id")
      .in("produto_id", idsChunk)
      .eq("ativo", true);
    for (const m of (maps ?? []) as Array<{
      produto_id: string;
      empresa_id: string;
    }>) {
      const set = empresasPorProduto.get(m.produto_id) ?? new Set<string>();
      set.add(m.empresa_id);
      empresasPorProduto.set(m.produto_id, set);
    }
  }

  return lista.map((p) => ({
    id: p.id,
    sku: p.sku,
    empresas: empresasPorProduto.get(p.id) ?? new Set(),
  }));
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Hash determinístico de um UUID → bit que define qual empresa pega o
 * produto compartilhado. Usa MD5 do uuid → 1º byte → mod 2.
 */
function hashBucket(produtoId: string): 0 | 1 {
  const h = createHash("md5").update(produtoId).digest();
  return (h[0] % 2) as 0 | 1;
}

interface PoolSplit {
  netair: ProdutoComMapping[];
  netparts: ProdutoComMapping[];
  semMapping: ProdutoComMapping[];
}

function splitar(produtos: ProdutoComMapping[]): PoolSplit {
  const netair: ProdutoComMapping[] = [];
  const netparts: ProdutoComMapping[] = [];
  const semMapping: ProdutoComMapping[] = [];

  for (const p of produtos) {
    const naNetAir = p.empresas.has(NETAIR_ID);
    const naNetParts = p.empresas.has(NETPARTS_ID);
    if (!naNetAir && !naNetParts) {
      semMapping.push(p);
      continue;
    }
    if (naNetAir && naNetParts) {
      if (hashBucket(p.id) === 0) netair.push(p);
      else netparts.push(p);
      continue;
    }
    if (naNetAir) netair.push(p);
    else netparts.push(p);
  }

  return { netair, netparts, semMapping };
}

interface ProgressoFila {
  nome: string;
  total: number;
  ok: number;
  fail: number;
  iniciado_em: number;
}

function fmtETA(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

// Workers paralelos puxando da mesma fila (rate-limit do tiny-queue cuida
// do throttling). Override via env WORKERS_POR_FILA.
const WORKERS_POR_FILA = parseInt(
  process.env.WORKERS_POR_FILA ?? "4",
  10,
);

async function processarFila(
  nome: string,
  empresaId: string,
  fila: ProdutoComMapping[],
  progresso: ProgressoFila,
): Promise<void> {
  let cursor = 0;
  const next = (): ProdutoComMapping | null =>
    cursor < fila.length ? fila[cursor++] : null;

  async function worker(workerIdx: number): Promise<void> {
    while (true) {
      const p = next();
      if (!p) return;
      try {
        await sincronizarProduto(p.id, { preferEmpresaId: empresaId });
        progresso.ok++;
      } catch (e) {
        progresso.fail++;
        if (progresso.fail <= 20 || progresso.fail % 50 === 0) {
          console.error(
            `[${nome}#${workerIdx}] ✗ ${p.sku} (${p.id}): ${(e as Error).message}`,
          );
        }
      }
      const done = progresso.ok + progresso.fail;
      if (done % 100 === 0 || done === progresso.total) {
        const elapsed = Date.now() - progresso.iniciado_em;
        const rate = done / (elapsed / 1000);
        const restante = progresso.total - done;
        const eta = rate > 0 ? (restante / rate) * 1000 : -1;
        const pct = ((done / progresso.total) * 100).toFixed(1);
        console.log(
          `[${nome}] ${done}/${progresso.total} (${pct}%) · ` +
            `ok=${progresso.ok} fail=${progresso.fail} · ` +
            `${rate.toFixed(2)}/s · ETA ${fmtETA(eta)}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: WORKERS_POR_FILA }, (_, i) => worker(i + 1)),
  );

  console.log(
    `[${nome}] CONCLUÍDO: ${progresso.ok} ok, ${progresso.fail} falhas em ${
      fmtETA(Date.now() - progresso.iniciado_em)
    }`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const limitIdx = args.indexOf("--limit");
  const limit =
    limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) || 0 : 0;

  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  console.log(`destino: ${supaUrl}`);
  if (!supaUrl.includes("ehbxpbeijofxtsbezwxd")) {
    console.warn("⚠ destino NÃO é staging — interrompendo por segurança.");
    process.exit(1);
  }
  console.log(
    `config: workers/fila=${WORKERS_POR_FILA} | ` +
      `tiny rate=${process.env.TINY_RATE_LIMIT_PER_MIN ?? "55"}/min/empresa | ` +
      `concurrent=${process.env.TINY_MAX_CONCURRENT ?? "5"}/empresa`,
  );

  console.log("carregando lista de produtos pra processar…");
  const produtos = await carregarLista(force, limit);
  console.log(`total elegível: ${produtos.length}`);
  if (produtos.length === 0) {
    console.log("nada pra fazer.");
    return;
  }

  const split = splitar(produtos);
  console.log(
    `split: NetAir=${split.netair.length} NetParts=${split.netparts.length} sem_mapping=${split.semMapping.length}`,
  );
  if (split.semMapping.length > 0) {
    console.warn(
      `⚠ ${split.semMapping.length} produto(s) sem mapping pra nenhuma empresa — serão pulados`,
    );
  }

  const t0 = Date.now();
  const progNetAir: ProgressoFila = {
    nome: "NetAir",
    total: split.netair.length,
    ok: 0,
    fail: 0,
    iniciado_em: t0,
  };
  const progNetParts: ProgressoFila = {
    nome: "NetParts",
    total: split.netparts.length,
    ok: 0,
    fail: 0,
    iniciado_em: t0,
  };

  await Promise.all([
    processarFila("NetAir", NETAIR_ID, split.netair, progNetAir),
    processarFila("NetParts", NETPARTS_ID, split.netparts, progNetParts),
  ]);

  const totalOk = progNetAir.ok + progNetParts.ok;
  const totalFail = progNetAir.fail + progNetParts.fail;
  console.log(
    `\n[final] ${totalOk} ok · ${totalFail} falhas · ${fmtETA(
      Date.now() - t0,
    )} total`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

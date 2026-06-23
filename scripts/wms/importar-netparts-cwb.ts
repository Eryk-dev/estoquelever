#!/usr/bin/env tsx
/**
 * scripts/wms/importar-netparts-cwb.ts
 *
 * 2ª rodada (2026-06-12): o arquivo INVENTARIO NETPARTS SP.csv é, na verdade,
 * estoque da NetAir fisicamente em CWB (decisão do Eryk). Importa o arquivo
 * INTEIRO pro galpão CWB, tag NetAir.
 *
 * Regras (herdadas + confirmadas pelo Eryk):
 *   - Padrão de código: X-CC-V (corredor 2 díg, vertical sem zero).
 *   - Código-prateleira X-N (ex PP-7, PE-2): aceito como loc literal.
 *   - "...TRAS"/"...FRENTE"/parentéticos: mergeia na loc base.
 *   - "FULL SALA"/"FULL ESCADA" e textos soltos (LOJA, OFICINA, PALETE...):
 *     loc literal em CWB.
 *   - Separadores ";" e "/": multi-loc, divide qty igual (resto na 1ª).
 *   - " SP ..." embutido no meio: pega a parte CWB (antes do " SP").
 *   - Sem localização: pula (decisão global anterior). SKU sem catálogo: pula.
 *   - Loc que mesmo assim não parseia: pula e lista no relatório.
 *
 * Idempotente por (produto, galpão, loc, motivo) — re-rodar não duplica e não
 * colide com o import anterior (motivo diferente).
 *
 *   npx tsx scripts/wms/importar-netparts-cwb.ts --dry
 *   npx tsx scripts/wms/importar-netparts-cwb.ts
 */

import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { inserirMovimentacao } from "../../src/lib/wms/ledger";

const DRY = process.argv.includes("--dry");
const MOTIVO = "Import inventário CSV 2026-06-12 (NETPARTS SP→CWB)";
const FILE = "INVENTARIO NETPARTS SP.csv";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(supabaseUrl, serviceKey);

const GALPAO_CWB = "14e22fe9-8dae-4950-b1e8-f38cffa60646";
const EMP_NETAIR = "4473ca97-67e7-44e5-a192-ec756146b691";

// ------------------------------------------------------------- parse loc

interface Parsed {
  codigo: string;
  status: "ok" | "texto" | "indef";
}

const TEXT_LOCS =
  /^(FULL SALA|FULL ESCADA|LOJA|OFICINA|VESTIARIO|VESTIÁRIO|PALETE FUNDO|PALETE|PALLET|PAREDÃO|PAREDAO|M3 SALA|CESTO.*|EXCESSO.*)$/;

function clean(raw: string): string {
  return raw
    .toUpperCase()
    .trim()
    .replace(/\(.*?\)/g, "") // remove (TRAS CP) etc
    .replace(/\b(TRAS|FRENTE)\b/g, "")
    .replace(/\s+SP\s+[A-Z].*$/, "") // " SP D 04-04" embutido → corta
    .replace(/\s+/g, " ")
    .trim();
}

function parseLoc(raw: string): Parsed {
  let s = clean(raw);
  if (!s) return { codigo: raw.toUpperCase(), status: "indef" };
  if (TEXT_LOCS.test(s)) return { codigo: s, status: "texto" };
  s = s.replace(/^([A-Z]) ([A-Z])(?=[ -])/, "$1$2"); // "C O-03-4" → "CO-03-4"
  // código cheio X-CC-V
  let m = s.match(/^([A-Z]+[0-9]?)[\s-]*([0-9]+)[\s-]+([0-9]+)$/);
  if (m) {
    return {
      codigo: `${m[1]}-${String(+m[2]).padStart(2, "0")}-${+m[3]}`,
      status: "ok",
    };
  }
  // código-prateleira X-N
  m = s.match(/^([A-Z]+[0-9]?)[\s-]*([0-9]+)$/);
  if (m) return { codigo: `${m[1]}-${+m[2]}`, status: "ok" };
  return { codigo: s, status: "indef" };
}

function splitLocs(loc: string): string[] {
  return loc
    .split(/[;/]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function canonKey(codigo: string): string {
  const up = codigo.toUpperCase().trim().replace(/\s+/g, " ");
  const m = up.match(/^([A-Z]+[0-9]*)\s*-\s*0*([0-9]+)\s*-\s*0*([0-9]+)$/);
  if (m) return `${m[1]}|${+m[2]}|${+m[3]}`;
  return `TXT|${up}`;
}

// --------------------------------------------------------------- helpers

interface Row {
  sku: string;
  loc: string;
  qty: number;
  produto: string;
}
function parseCsv(path: string): Row[] {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const mm = lines[i].match(/"((?:[^"]|"")*)"/g);
    if (!mm) continue;
    const f = mm.map((x) => x.slice(1, -1).replace(/""/g, '"'));
    out.push({
      produto: (f[0] ?? "").trim(),
      sku: (f[1] ?? "").trim(),
      loc: (f[4] ?? "").trim(),
      qty: parseFloat((f[5] ?? "0").replace(/\./g, "").replace(",", ".")),
    });
  }
  return out;
}

async function fetchAll<T>(table: string, select: string, eq?: [string, string]): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (eq) q = q.eq(eq[0], eq[1]);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
    from += 1000;
  }
  return out;
}

// ------------------------------------------------------------------ main

async function main() {
  const produtos = await fetchAll<{ id: string; sku: string }>("siso_produtos", "id,sku");
  const porSku = new Map(produtos.map((p) => [p.sku, p.id]));
  console.log(`catálogo: ${porSku.size} SKUs`);

  const locsCwb = await fetchAll<{ id: string; codigo: string }>(
    "siso_localizacoes",
    "id,codigo",
    ["galpao_id", GALPAO_CWB],
  );
  const locByCanon = new Map<string, { id: string; codigo: string }>();
  for (const l of locsCwb) {
    const k = canonKey(l.codigo);
    const cur = locByCanon.get(k);
    if (!cur || (/-0[0-9]+$/.test(cur.codigo) && !/-0[0-9]+$/.test(l.codigo))) locByCanon.set(k, l);
  }
  console.log(`locs CWB existentes: ${locByCanon.size} chaves canônicas`);

  // plano: produto|loc-codigo → qty
  interface P {
    produtoId: string;
    codigo: string;
    qty: number;
  }
  const plano = new Map<string, P>();
  const pulados: Array<{ sku: string; qty: number; loc: string; motivo: string }> = [];

  for (const r of parseCsv(FILE)) {
    if (!r.sku || r.qty <= 0) {
      if (r.produto) pulados.push({ sku: r.sku, qty: r.qty, loc: r.loc, motivo: "sem SKU ou qty<=0" });
      continue;
    }
    if (!r.loc) {
      pulados.push({ sku: r.sku, qty: r.qty, loc: "", motivo: "sem localização" });
      continue;
    }
    const produtoId = porSku.get(r.sku);
    if (!produtoId) {
      pulados.push({ sku: r.sku, qty: r.qty, loc: r.loc, motivo: "SKU sem catálogo" });
      continue;
    }
    const partes = splitLocs(r.loc);
    const base = Math.floor(r.qty / partes.length);
    const resto = r.qty - base * partes.length;
    partes.forEach((p, i) => {
      const qa = base + (i === 0 ? resto : 0);
      if (qa <= 0) return;
      const info = parseLoc(p);
      if (info.status === "indef") {
        pulados.push({ sku: r.sku, qty: qa, loc: r.loc, motivo: `loc indefinida: ${info.codigo}` });
        return;
      }
      const key = `${produtoId}|${info.codigo}`;
      const cur = plano.get(key);
      if (cur) cur.qty += qa;
      else plano.set(key, { produtoId, codigo: info.codigo, qty: qa });
    });
  }

  // locs a criar
  const aCriar = new Map<string, string>(); // canon → codigo
  for (const p of plano.values()) {
    const k = canonKey(p.codigo);
    if (!locByCanon.has(k) && !aCriar.has(k)) aCriar.set(k, p.codigo);
  }

  const totalQty = [...plano.values()].reduce((s, p) => s + p.qty, 0);
  const pulQty = pulados.reduce((s, p) => s + p.qty, 0);
  console.log(`\nplano: ${plano.size} movs agregadas / ${totalQty} un → CWB tag NetAir`);
  console.log(`locs novas a criar: ${aCriar.size}`);
  console.log(`pulados: ${pulados.length} parcelas / ${pulQty} un`);

  fs.writeFileSync(
    "import-netparts-cwb-pulados.csv",
    ["sku,qty,loc_original,motivo", ...pulados.map((p) => [p.sku, p.qty, p.loc, p.motivo].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n"),
  );
  console.log("relatório → import-netparts-cwb-pulados.csv");

  if (DRY) {
    console.log("\n--dry: nada gravado.");
    const fam: Record<string, number> = {};
    for (const p of plano.values()) {
      const f = (p.codigo.match(/^[A-ZÀ-Ü]+[0-9]*/) || ["?"])[0];
      fam[f] = (fam[f] || 0) + p.qty;
    }
    console.log("\nqty por família (top 20):");
    console.log(
      Object.entries(fam)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([f, q]) => `  ${f}: ${q}`)
        .join("\n"),
    );
    return;
  }

  // cria locs
  console.log("\ncriando locs...");
  for (const codigo of aCriar.values()) {
    const { data, error } = await sb
      .from("siso_localizacoes")
      .insert({ galpao_id: GALPAO_CWB, codigo, tipo: "picking" })
      .select("id,codigo")
      .single();
    if (error) {
      console.error(`  ERRO loc ${codigo}: ${error.message}`);
      continue;
    }
    locByCanon.set(canonKey(codigo), data);
  }
  console.log("locs criadas.");

  // idempotência: movs deste import já existentes
  const movs = await fetchAll<{ produto_id: string; localizacao_id: string }>(
    "siso_movimentacoes",
    "produto_id,localizacao_id",
    ["motivo", MOTIVO],
  );
  const jaFeito = new Set(movs.map((m) => `${m.produto_id}|${m.localizacao_id}`));

  let criados = 0,
    skip = 0,
    erros = 0;
  const itens = [...plano.values()];
  let idx = 0;
  async function worker() {
    while (idx < itens.length) {
      const p = itens[idx++];
      const loc = locByCanon.get(canonKey(p.codigo));
      if (!loc) {
        erros++;
        console.error(`  sem loc: ${p.codigo}`);
        continue;
      }
      if (jaFeito.has(`${p.produtoId}|${loc.id}`)) {
        skip++;
        continue;
      }
      try {
        await inserirMovimentacao({
          tripla: { produto_id: p.produtoId, galpao_id: GALPAO_CWB, localizacao_id: loc.id },
          tipo: "E",
          qty: p.qty,
          origem_tipo: "inventario_inicial",
          empresa_compradora_id: EMP_NETAIR,
          motivo: MOTIVO,
        });
        criados++;
        if (criados % 200 === 0) console.log(`  ${criados}/${itens.length}...`);
      } catch (e) {
        erros++;
        console.error(`  ERRO ${p.codigo} qty=${p.qty}: ${String(e).slice(0, 160)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`\nfeito: ${criados} criadas | ${skip} já existiam | ${erros} erros`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * scripts/wms/importar-inventario-csv.ts
 *
 * Import one-off dos inventários CSV (export Tiny) pro ledger 3D.
 * Escopo decidido pelo Eryk em 2026-06-12:
 *   - INVENTARIO NETAIR CWB.csv → galpão CWB (tag NetAir); famílias CE/CG/PL
 *     e prefixos SP/SPA vão pro galpão SP (tag NetParts).
 *   - EASY SP.csv → galpão SP (tag EasyPeasy SP).
 *   - INVENTARIO NETPARTS SP.csv: NÃO importa (decisão do Eryk).
 *
 * Regras (anotadas pelo Eryk na revisão de locs-novas-CWB.csv):
 *   - Padrão de código: PREFIX-CC-V (corredor 2 dígitos, vertical sem zero).
 *   - Linhas A/B/C/D com "SP ..." embutido: exclui a parte SP, qty toda na CWB.
 *   - Multi-loc (";" ou casos anotados): divide qty igualmente, resto na 1ª.
 *   - Linhas sem localização: pula. SKU sem match no catálogo: pula.
 *   - Locs INDEFINIDAS (ver overrides): pula e lista no relatório.
 *
 * Idempotente: agrega por (produto, galpão, loc, empresa-tag) e pula o que já
 * tem mov 'inventario_inicial' com essa mesma combinação.
 *
 *   npx tsx scripts/wms/importar-inventario-csv.ts --dry   # preview
 *   npx tsx scripts/wms/importar-inventario-csv.ts         # grava
 */

import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { inserirMovimentacao } from "../../src/lib/wms/ledger";

const DRY = process.argv.includes("--dry");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(supabaseUrl, serviceKey);

// ---------------------------------------------------------------- CSV parse

interface Row {
  produto: string;
  sku: string;
  loc: string;
  qty: number;
}

function parseCsv(path: string): Row[] {
  const txt = fs.readFileSync(path, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/"((?:[^"]|"")*)"/g);
    if (!m) continue;
    const f = m.map((s) => s.slice(1, -1).replace(/""/g, '"'));
    const qty = parseFloat((f[5] ?? "0").replace(/\./g, "").replace(",", "."));
    rows.push({
      produto: (f[0] ?? "").trim(),
      sku: (f[1] ?? "").trim(),
      loc: (f[4] ?? "").trim(),
      qty,
    });
  }
  return rows;
}

// ------------------------------------------------------- normalização de loc

type Galpao = "CWB" | "SP";
interface Alvo {
  g: Galpao | "?";
  codigo: string;
  status: "ok" | "texto" | "indefinido";
}

const TEXT_LOCS =
  /^(FULL ESCADA|FULL SALA|LOJA|OFICINA|VESTIARIO|VESTIÁRIO|PALETE FUNDO|PALETE|PALLET|PAREDÃO|PAREDAO|M3 SALA|M1|CESTO.*|EXCESSO.*)$/;

function normToken(raw: string): Alvo {
  let s = raw.toUpperCase().trim().replace(/\s+/g, " ");
  if (!s) return { g: "?", codigo: raw, status: "indefinido" };
  if (TEXT_LOCS.test(s)) return { g: "?", codigo: s, status: "texto" };
  s = s.replace(/^([A-Z]) ([A-Z])(?=[ -])/, "$1$2"); // "C O-03-4" → "CO-03-4"
  const m = s.match(/^([A-Z]+[0-9]?)[\s-]*([0-9 -]+)$/);
  if (!m) return { g: "?", codigo: s, status: "indefinido" };
  const prefix = m[1];
  let nums = m[2].split(/[\s-]+/).filter(Boolean).map(Number);
  if (nums.length === 3 && nums[0] === 0) nums = [nums[1], nums[2]]; // CX-0-1-4
  if (nums.length !== 2) return { g: "?", codigo: s, status: "indefinido" };
  const [cc, v] = nums;
  return {
    g: "?",
    codigo: `${prefix}-${String(cc).padStart(2, "0")}-${v}`,
    status: "ok",
  };
}

function normSpToken(raw: string): Alvo {
  let s = raw.toUpperCase().trim().replace(/\s+/g, " ");
  s = s.replace(/^SPA[\s-]*/, "A ");
  s = s.replace(/^SP[\s-]*/, "");
  if (!s) return { g: "?", codigo: raw.toUpperCase(), status: "indefinido" };
  return normToken(s);
}

// Casos anotados pelo Eryk (arquivo NETAIR). 'INDEF' = pula a parcela.
type OvrItem = { g: Galpao; t: string } | "INDEF";
const OVR: Record<string, OvrItem[]> = {
  "E-10-9 SP B 03-03 CX 06-01": [
    { g: "CWB", t: "E-10-9" },
    { g: "SP", t: "B 03-03" },
    { g: "CWB", t: "CX 06-01" },
  ],
  "PP2-7 SP B-01- 01": ["INDEF", { g: "SP", t: "B-01-01" }],
  "PL SP 06-02": [{ g: "SP", t: "PL 06-02" }],
  "CX-01-7  - SP PL  04-05": [
    { g: "CWB", t: "CX-01-7" },
    { g: "SP", t: "PL 04-05" },
  ],
  "CX-03-10 SP B 01-03": [
    { g: "CWB", t: "CX-03-10" },
    { g: "SP", t: "B 01-03" },
  ],
  "CG 02-02 SP B-03-03": [
    { g: "SP", t: "CG 02-02" },
    { g: "SP", t: "B-03-03" },
  ],
  "CG-02-3 - SP B03-3": [
    { g: "SP", t: "CG-02-3" },
    { g: "SP", t: "B 03-3" },
  ],
  "PE-01-1 SP D 04-04": [
    { g: "CWB", t: "PE-01-1" },
    { g: "SP", t: "D 04-04" },
  ],
  "PE-02-2 SP D 04-04": [
    { g: "CWB", t: "PE-02-2" },
    { g: "SP", t: "D 04-04" },
  ],
  "PE-04- SP B 01-02": ["INDEF", { g: "SP", t: "B 01-02" }],
  "A-02-2 SP B 03-03": [{ g: "CWB", t: "A-02-2" }],
  "C-01-1 SP B 01-02": [{ g: "CWB", t: "C-01-1" }],
  "C-02-3 SP A 01-03": [{ g: "CWB", t: "C-02-3" }],
  "C-02-5 SP B-01-02": [{ g: "CWB", t: "C-02-5" }],
  "D-02-1 SP  B 02-02": [{ g: "CWB", t: "D-02-1" }],
  "D-02-4 - SP B 01-02": [{ g: "CWB", t: "D-02-4" }],
  "CO-07-06 CO08-06": [
    { g: "CWB", t: "CO 07-06" },
    { g: "CWB", t: "CO 08-06" },
  ],
  "CX-03-2 -CX-03-3": [
    { g: "CWB", t: "CX-03-2" },
    { g: "CWB", t: "CX-03-3" },
  ],
  "PL 04-05 - PL04-6": [
    { g: "SP", t: "PL 04-05" },
    { g: "SP", t: "PL 04-6" },
  ],
  "G-01-5 TRAS": [{ g: "CWB", t: "G-01-5" }],
  "B-03-5 B": [{ g: "CWB", t: "B-03-5" }],
  "C O-03-4": [{ g: "CWB", t: "CO 03-4" }],
  "FULL ESCADA": [{ g: "CWB", t: "FULL ESCADA" }],
  "/SP": ["INDEF"],
  "/sp": ["INDEF"],
  "-03-6": ["INDEF"],
};

// famílias do arquivo NETAIR que o Eryk mandou pro galpão SP
const FAM_SP_NETAIR = /^(CE|CG|PL)([\s-]|$)/;

function resolveParte(parte: string, fileKey: string): Alvo[] {
  const raw = parte.trim();
  const upRaw = raw.toUpperCase().replace(/\s+/g, " ");
  const ovr = OVR[raw] ?? OVR[upRaw];
  if (ovr) {
    return ovr.map((o) => {
      if (o === "INDEF") return { g: "?", codigo: upRaw, status: "indefinido" } as Alvo;
      const n = o.t === "FULL ESCADA" ? ({ g: "?", codigo: "FULL ESCADA", status: "texto" } as Alvo) : normToken(o.t);
      return { ...n, g: o.g };
    });
  }
  if (fileKey === "NETAIR CWB") {
    if (/^SPA?([\s-]|$)/.test(upRaw)) return [{ ...normSpToken(upRaw), g: "SP" }];
    if (FAM_SP_NETAIR.test(upRaw)) return [{ ...normToken(upRaw), g: "SP" }];
    return [{ ...normToken(upRaw), g: "CWB" }];
  }
  return [{ ...normToken(upRaw), g: "SP" }]; // EASY SP
}

// --------------------------------------------------------------------- main

async function fetchAll<T>(table: string, select: string, filter?: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) {
      const [col, val] = filter.split("=");
      q = q.eq(col, val);
    }
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function canonKey(codigo: string): string {
  const up = codigo.toUpperCase().trim().replace(/\s+/g, " ");
  const m = up.match(/^([A-Z]+[0-9]*)\s*-\s*0*([0-9]+)\s*-\s*0*([0-9]+)$/);
  if (m) return `${m[1]}|${+m[2]}|${+m[3]}`;
  return `TXT|${up}`;
}

async function main() {
  // referências
  const galpoes = await fetchAll<{ id: string; nome: string }>("siso_galpoes", "id,nome");
  const empresas = await fetchAll<{ id: string; nome: string; cnpj: string }>(
    "siso_empresas",
    "id,nome,cnpj",
  );
  const gid: Record<Galpao, string> = {
    CWB: galpoes.find((g) => g.nome === "CWB")!.id,
    SP: galpoes.find((g) => g.nome === "SP")!.id,
  };
  const empNetAir = empresas.find((e) => e.cnpj === "34857388000163")!.id;
  const empNetParts = empresas.find((e) => e.cnpj === "34857388000244")!.id;
  const empEasySp = empresas.find((e) => e.cnpj === "45341545000280")!.id;

  // catálogo SKU → uuid
  const produtos = await fetchAll<{ id: string; sku: string }>("siso_produtos", "id,sku");
  const porSku = new Map(produtos.map((p) => [p.sku, p.id]));
  console.log(`catálogo: ${porSku.size} SKUs`);

  // locs existentes por galpão (chave canônica → {id, codigo})
  const locsPorGalpao: Record<Galpao, Map<string, { id: string; codigo: string }>> = {
    CWB: new Map(),
    SP: new Map(),
  };
  for (const g of ["CWB", "SP"] as Galpao[]) {
    const locs = await fetchAll<{ id: string; codigo: string }>(
      "siso_localizacoes",
      "id,codigo",
      `galpao_id=${gid[g]}`,
    );
    for (const l of locs) {
      const k = canonKey(l.codigo);
      const cur = locsPorGalpao[g].get(k);
      // duplicata de formato (A-01-01 vs A-01-1): prefere a sem zero no vertical
      if (!cur || (/-0[0-9]+$/.test(cur.codigo) && !/-0[0-9]+$/.test(l.codigo))) {
        locsPorGalpao[g].set(k, l);
      }
    }
    console.log(`locs ${g}: ${locsPorGalpao[g].size} chaves canônicas`);
  }

  // arquivos no escopo
  const FILES: Array<{ key: string; path: string; tagCwb?: string; tagSp: string }> = [
    {
      key: "NETAIR CWB",
      path: "INVENTARIO NETAIR CWB.csv",
      tagCwb: empNetAir,
      tagSp: empNetParts,
    },
    { key: "EASY SP", path: "EASY SP.csv", tagSp: empEasySp },
  ];

  // plano agregado: (produto|galpao|loc-codigo|empresa) → qty
  interface Parcela {
    produtoId: string;
    g: Galpao;
    codigo: string;
    empresaId: string;
    qty: number;
    arquivo: string;
  }
  const plano = new Map<string, Parcela>();
  const pulados: Array<{ arquivo: string; sku: string; qty: number; loc: string; motivo: string }> = [];

  for (const file of FILES) {
    const rows = parseCsv(file.path);
    for (const r of rows) {
      if (!r.sku || r.qty <= 0) {
        if (r.produto) pulados.push({ arquivo: file.key, sku: r.sku, qty: r.qty, loc: r.loc, motivo: "sem SKU ou qty<=0" });
        continue;
      }
      if (!r.loc) {
        pulados.push({ arquivo: file.key, sku: r.sku, qty: r.qty, loc: "", motivo: "sem localização" });
        continue;
      }
      const produtoId = porSku.get(r.sku);
      if (!produtoId) {
        pulados.push({ arquivo: file.key, sku: r.sku, qty: r.qty, loc: r.loc, motivo: "SKU sem match no catálogo" });
        continue;
      }
      const partes = r.loc.split(";").map((p) => p.trim()).filter(Boolean);
      const alvos: Alvo[] = [];
      for (const p of partes) alvos.push(...resolveParte(p, file.key));
      const n = alvos.length;
      const base = Math.floor(r.qty / n);
      const resto = r.qty - base * n;
      alvos.forEach((a, i) => {
        const q = base + (i === 0 ? resto : 0);
        if (q <= 0) return;
        if (a.status === "indefinido" || a.g === "?") {
          pulados.push({ arquivo: file.key, sku: r.sku, qty: q, loc: r.loc, motivo: `loc indefinida: ${a.codigo}` });
          return;
        }
        const empresaId = a.g === "CWB" ? file.tagCwb! : file.tagSp;
        const key = `${produtoId}|${a.g}|${a.codigo}|${empresaId}`;
        const cur = plano.get(key);
        if (cur) cur.qty += q;
        else plano.set(key, { produtoId, g: a.g, codigo: a.codigo, empresaId, qty: q, arquivo: file.key });
      });
    }
  }

  // idempotência: movs inventario_inicial já existentes
  const movsExist = await fetchAll<{
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    empresa_compradora_id: string | null;
  }>(
    "siso_movimentacoes",
    "produto_id,galpao_id,localizacao_id,empresa_compradora_id",
    "origem_tipo=inventario_inicial",
  );
  const locIdParaCodigo = new Map<string, string>();
  for (const g of ["CWB", "SP"] as Galpao[]) {
    for (const l of locsPorGalpao[g].values()) locIdParaCodigo.set(l.id, `${g}|${canonKey(l.codigo)}`);
  }
  const jaImportado = new Set(
    movsExist.map((m) => `${m.produto_id}|${locIdParaCodigo.get(m.localizacao_id) ?? m.localizacao_id}|${m.empresa_compradora_id}`),
  );

  // locs a criar
  const aCriar = new Map<string, { g: Galpao; codigo: string }>();
  for (const p of plano.values()) {
    const k = canonKey(p.codigo);
    if (!locsPorGalpao[p.g].has(k)) aCriar.set(`${p.g}|${k}`, { g: p.g, codigo: p.codigo });
  }

  const porGalpao = { CWB: { movs: 0, qty: 0 }, SP: { movs: 0, qty: 0 } };
  for (const p of plano.values()) {
    porGalpao[p.g].movs++;
    porGalpao[p.g].qty += p.qty;
  }
  console.log(`\nplano: ${plano.size} movs agregadas`);
  console.log(`  CWB: ${porGalpao.CWB.movs} movs / ${porGalpao.CWB.qty} un`);
  console.log(`  SP:  ${porGalpao.SP.movs} movs / ${porGalpao.SP.qty} un`);
  console.log(`locs novas: ${[...aCriar.values()].filter((l) => l.g === "CWB").length} CWB + ${[...aCriar.values()].filter((l) => l.g === "SP").length} SP`);
  console.log(`pulados: ${pulados.length} parcelas`);

  // relatório de pulados
  const rel = [
    "arquivo,sku,qty,loc_original,motivo",
    ...pulados.map((p) => [p.arquivo, p.sku, p.qty, p.loc, p.motivo].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")),
  ].join("\n");
  fs.writeFileSync("import-inventario-pulados.csv", rel);
  console.log("relatório de pulados → import-inventario-pulados.csv");

  if (DRY) {
    console.log("\n--dry: nada gravado.");
    return;
  }

  // cria locs
  console.log("\ncriando locs...");
  for (const { g, codigo } of aCriar.values()) {
    const { data, error } = await sb
      .from("siso_localizacoes")
      .insert({ galpao_id: gid[g], codigo, tipo: "picking" })
      .select("id,codigo")
      .single();
    if (error) {
      console.error(`  ERRO loc ${g}/${codigo}: ${error.message}`);
      continue;
    }
    locsPorGalpao[g].set(canonKey(codigo), data);
  }
  console.log("locs criadas.");

  // insere movs
  let criados = 0;
  let skipIdem = 0;
  let erros = 0;
  const itens = [...plano.values()];
  const CONC = 8;
  let idx = 0;
  async function worker() {
    while (idx < itens.length) {
      const p = itens[idx++];
      const loc = locsPorGalpao[p.g].get(canonKey(p.codigo));
      if (!loc) {
        erros++;
        console.error(`  sem loc: ${p.g}/${p.codigo}`);
        continue;
      }
      const idemKey = `${p.produtoId}|${p.g}|${canonKey(p.codigo)}|${p.empresaId}`;
      if (jaImportado.has(idemKey)) {
        skipIdem++;
        continue;
      }
      try {
        await inserirMovimentacao({
          tripla: { produto_id: p.produtoId, galpao_id: gid[p.g], localizacao_id: loc.id },
          tipo: "E",
          qty: p.qty,
          origem_tipo: "inventario_inicial",
          empresa_compradora_id: p.empresaId,
          motivo: `Import inventário CSV 2026-06-12 (${p.arquivo})`,
        });
        criados++;
        if (criados % 100 === 0) console.log(`  ${criados}/${itens.length}...`);
      } catch (e) {
        erros++;
        console.error(`  ERRO mov ${p.g}/${p.codigo} qty=${p.qty}: ${String(e).slice(0, 200)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\nfeito: ${criados} movs criadas | ${skipIdem} já existiam | ${erros} erros`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

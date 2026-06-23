#!/usr/bin/env tsx
/**
 * scripts/wms/portar-pedidos-antigos.ts — Portabilidade de estado (2026-06-14).
 *
 * Importa pedidos pré-embalado do SISO ANTIGO (prod wrbrbhuhsaaupqsimkqz) pro
 * NOVO (staging ehbxpbeijofxtsbezwxd) SEM re-emitir NF. Todos os 86 candidatos
 * já têm NF fiscal no antigo — replay nativo re-emitiria.
 *
 * Chave da segurança fiscal: o novo só emite NF nova quando pedido.nota_fiscal_id
 * é NULL (gerarNotaFiscalPedido: `if (notaFiscalIdExistente) return`). Importando
 * com nota_fiscal_id = o id Tiny antigo, NENHUM caminho do worker emite NF nova
 * (vale pra propria/executarSaidaPropria E oc/executarMarcadoresOnly).
 *
 * Dois destinos, decididos pelo roteador real contra o estoque ATUAL do novo:
 *   - SEPARACAO  (rota propria/transferencia, cobre 100%): status_separacao=
 *     'aguardando_separacao' + reservas R. Sem job. Pick faz só o S → sem NF nova.
 *   - COMPRA      (sem cobertura): status_separacao='aguardando_compra',
 *     decisao_final='oc', item.compra_status='aguardando_compra',
 *     separacao_galpao_id=galpão casa. Entra na aba de compras; quando o estoque
 *     entrar, o reconciliador-oc casa e o worker faz o S reusando a NF (sem
 *     re-emissão, pelo guard acima). Sem reserva, sem job.
 *   - REQUER_SKU  (produto_id=0 / sem produto no novo): NÃO importa — reporta.
 *
 * Uso:
 *   npx tsx scripts/wms/portar-pedidos-antigos.ts                      # DRY-RUN (read-only)
 *   ALLOW_PORT=true npx tsx scripts/wms/portar-pedidos-antigos.ts --apply
 *   ... --modo=separacao   # só os cobríveis (21)
 *   ... --modo=compra      # só os de compra (64)
 *   ... --ids=145495,82774 | --limit=5
 *
 * .env aponta pro NOVO (default). --apply exige ALLOW_PORT=true.
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createServiceClient } from "../../src/lib/supabase-server";
import { getEmpresaById } from "../../src/lib/empresa-lookup";
import { rotearPedidoDoBanco, type RotaResult } from "../../src/lib/wms/roteamento";
import { reservarAtomico } from "../../src/lib/wms/reservas";
import { ensureProdutoFromTiny } from "../../src/lib/wms/sync-tiny";
import { getFornecedorBySku } from "../../src/lib/sku-fornecedor";

interface PayloadItem {
  produto: { id: number; sku?: string | null; descricao?: string | null };
  quantidade: number;
}
interface Payload {
  id: string;
  numero?: string;
  data?: string;
  dataEnvio?: string | null;
  idPedidoEcommerce?: string;
  nomeEcommerce?: string;
  cliente?: { nome?: string; cpfCnpj?: string };
  formaEnvio?: { id?: string; descricao?: string };
  formaFrete?: { id?: string; descricao?: string };
  itens?: PayloadItem[];
}
interface OldPedido {
  id: string;
  numero: string;
  status_separacao: string;
  empresa_origem_id: string;
  chave_acesso_nf: string | null;
  nota_fiscal_id: number | null;
  url_danfe?: string | null;
  agrupamento_expedicao_id?: string | null;
  expedicao_id?: string | null;
  payload_original: Payload;
}

type Empresa = NonNullable<Awaited<ReturnType<typeof getEmpresaById>>>;
type RotaCobre = Extract<RotaResult, { decisao: "propria" | "transferencia" }>;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALLOW = process.env.ALLOW_PORT === "true";
const modoArg = (args.find((a) => a.startsWith("--modo="))?.slice(7) ?? "todos") as
  | "todos"
  | "separacao"
  | "compra";
const idsArg = args.find((a) => a.startsWith("--ids="))?.slice(6);
const limitArg = args.find((a) => a.startsWith("--limit="))?.slice(8);
const onlyIds = idsArg ? new Set(idsArg.split(",").map((s) => s.trim())) : null;
const limit = limitArg ? Number(limitArg) : null;

function tinyDateTime(d?: string | null): string | null {
  if (!d) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d;
}

type Classe = "SEPARACAO" | "COMPRA" | "REQUER_SKU" | "JA_NO_NOVO";

interface Plano {
  classe: Classe;
  detalhe: string;
  rota?: RotaCobre; // só SEPARACAO
}

async function resolverItens(
  sb: ReturnType<typeof createServiceClient>,
  empresaId: string,
  payload: Payload,
  autoProvision: boolean,
): Promise<{ mapByTiny: Map<number, string>; id0: boolean; naoMapeados: number }> {
  const itens = payload.itens ?? [];
  const tinyIds = itens.map((i) => i.produto.id);
  const { data: mappings } = await sb
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", empresaId)
    .in("tiny_produto_id", tinyIds);
  const mapByTiny = new Map<number, string>();
  for (const m of mappings ?? []) mapByTiny.set(Number(m.tiny_produto_id), m.produto_id as string);

  const id0 = itens.some((i) => i.produto.id === 0);

  if (autoProvision) {
    for (const it of itens) {
      if (it.produto.id <= 0 || mapByTiny.has(it.produto.id) || !it.produto.sku) continue;
      try {
        const uuid = await ensureProdutoFromTiny(it.produto.sku, empresaId, it.produto.id);
        mapByTiny.set(it.produto.id, uuid);
      } catch (e) {
        console.warn(`  ⚠ auto-provision tiny=${it.produto.id} sku=${it.produto.sku}: ${(e as Error).message}`);
      }
    }
  }
  const naoMapeados = itens.filter((i) => i.produto.id > 0 && !mapByTiny.has(i.produto.id)).length;
  return { mapByTiny, id0, naoMapeados };
}

async function planejar(
  old: OldPedido,
  empresa: Empresa,
  autoProvision: boolean,
): Promise<{ plano: Plano; mapByTiny: Map<number, string> }> {
  const sb = createServiceClient();
  const payload = old.payload_original;

  const { data: existe } = await sb
    .from("siso_pedidos")
    .select("status_separacao")
    .eq("id", old.id)
    .maybeSingle();

  const { mapByTiny, id0, naoMapeados } = await resolverItens(sb, empresa.empresaId, payload, autoProvision);

  if (existe) return { plano: { classe: "JA_NO_NOVO", detalhe: `já no novo (${existe.status_separacao ?? "—"})` }, mapByTiny };
  if (id0 || naoMapeados > 0)
    return {
      plano: { classe: "REQUER_SKU", detalhe: id0 ? "item produto_id=0" : `${naoMapeados} item(ns) sem produto no novo` },
      mapByTiny,
    };

  const itensRotear = (payload.itens ?? []).map((i) => ({
    produto_id: mapByTiny.get(i.produto.id) as string,
    qty: i.quantidade,
  }));
  const rota = await rotearPedidoDoBanco(empresa.empresaId, itensRotear);

  if (rota.decisao === "propria" || rota.decisao === "transferencia") {
    return {
      plano: { classe: "SEPARACAO", detalhe: `${rota.decisao} galpão ${rota.galpao_id.slice(0, 8)}`, rota },
      mapByTiny,
    };
  }
  return { plano: { classe: "COMPRA", detalhe: "sem estoque no novo → aba de compras (OC)" }, mapByTiny };
}

async function gravarPedidoEItens(
  old: OldPedido,
  empresa: Empresa,
  opts: {
    sugestao: "propria" | "transferencia" | "oc";
    decisao_final: "propria" | "transferencia" | "oc";
    status_separacao: "aguardando_separacao" | "aguardando_compra";
    separacao_galpao_id: string;
    compraStatusItem: string | null;
    marcadores: string[];
  },
): Promise<void> {
  const sb = createServiceClient();
  const p = old.payload_original;

  // Imagem + gtin do catálogo (siso_produtos por sku) — pro thumbnail do item.
  const skus = Array.from(new Set((p.itens ?? []).map((i) => i.produto.sku).filter(Boolean) as string[]));
  const { data: prods } = await sb
    .from("siso_produtos")
    .select("sku, imagem_url, gtin")
    .in("sku", skus);
  const prodBySku = new Map((prods ?? []).map((pr) => [pr.sku as string, pr]));

  // Vendedor auto pra marketplaces rastreados (espelha webhook): system-marketplace
  // + "<marketplace> <empresa>". "ML_*" NÃO casa (só "Mercado Livre"/"Shopee" exato).
  const TRACKED = new Set(["Mercado Livre", "Shopee"]);
  let vendedorId: string | null = null;
  let vendedorNome: string | null = null;
  if (p.nomeEcommerce && TRACKED.has(p.nomeEcommerce)) {
    const { data: emp } = await sb.from("siso_empresas").select("nome").eq("id", empresa.empresaId).maybeSingle();
    const { data: sysu } = await sb.from("siso_usuarios").select("id").eq("nome", "system-marketplace").maybeSingle();
    vendedorId = sysu?.id ?? null;
    vendedorNome = emp?.nome ? `${p.nomeEcommerce} ${emp.nome}` : null;
  }

  const { error: pedErr } = await sb.from("siso_pedidos").upsert(
    {
      id: old.id,
      numero: p.numero ?? old.numero,
      data: p.data ?? null,
      filial_origem: empresa.galpaoNome as "CWB" | "SP",
      empresa_origem_id: empresa.empresaId,
      id_pedido_ecommerce: p.idPedidoEcommerce ?? null,
      nome_ecommerce: p.nomeEcommerce ?? null,
      cliente_nome: p.cliente?.nome ?? null,
      cliente_cpf_cnpj: p.cliente?.cpfCnpj ?? null,
      forma_envio_id: p.formaEnvio?.id ?? null,
      forma_envio_descricao: p.formaEnvio?.descricao ?? null,
      forma_frete_id: p.formaFrete?.id ?? null,
      sugestao: opts.sugestao,
      sugestao_motivo: "Portado do sistema antigo (NF já emitida — sem re-emissão)",
      status: "executando",
      tipo_resolucao: null,
      decisao_final: opts.decisao_final,
      separacao_galpao_id: opts.separacao_galpao_id,
      status_separacao: opts.status_separacao,
      estoque_lancado: false,
      nf_estoque_lancado: false,
      // NF antiga (id Tiny + chave) — bloqueia re-emissão no worker.
      nota_fiscal_id: old.nota_fiscal_id,
      chave_acesso_nf: old.chave_acesso_nf,
      url_danfe: old.url_danfe ?? null,
      agrupamento_expedicao_id: old.agrupamento_expedicao_id ?? null,
      expedicao_id: old.expedicao_id ?? null,
      prazo_envio: tinyDateTime(p.dataEnvio),
      marcadores: opts.marcadores,
      payload_original: p,
      vendedor_id: vendedorId,
      vendedor_nome: vendedorNome,
      origem_pedido: "manual", // CHECK só aceita webhook|manual; tag de port fica em marcadores=['PORTADO']
    },
    { onConflict: "id" },
  );
  if (pedErr) throw new Error(`pedido upsert: ${pedErr.message}`);

  for (const item of p.itens ?? []) {
    const { error: itErr } = await sb.from("siso_pedido_itens").upsert(
      {
        pedido_id: old.id,
        produto_id: item.produto.id,
        produto_id_tiny: item.produto.id,
        sku: item.produto.sku ?? "",
        descricao: item.produto.descricao ?? "",
        quantidade_pedida: item.quantidade,
        compra_status: opts.compraStatusItem,
        imagem_url: prodBySku.get(item.produto.sku ?? "")?.imagem_url ?? null,
        gtin: prodBySku.get(item.produto.sku ?? "")?.gtin ?? null,
        fornecedor_oc: getFornecedorBySku(item.produto.sku).fornecedor,
      },
      { onConflict: "pedido_id,produto_id" },
    );
    if (itErr) throw new Error(`item upsert: ${itErr.message}`);
  }
}

async function importarSeparacao(old: OldPedido, empresa: Empresa, rota: RotaCobre): Promise<void> {
  await gravarPedidoEItens(old, empresa, {
    sugestao: rota.decisao,
    decisao_final: rota.decisao,
    status_separacao: "aguardando_separacao",
    separacao_galpao_id: rota.galpao_id,
    compraStatusItem: null,
    marcadores: ["PORTADO", empresa.galpaoNome, "LVR"],
  });
  for (const r of rota.rotas) {
    await reservarAtomico({
      tripla: { produto_id: r.produto_id, galpao_id: r.galpao_id, localizacao_id: r.localizacao_id },
      qty: r.qty,
      pedido_id: old.id,
      ttl_horas: 24 * 30,
    });
  }
}

async function importarCompra(old: OldPedido, empresa: Empresa): Promise<void> {
  await gravarPedidoEItens(old, empresa, {
    sugestao: "oc",
    decisao_final: "oc",
    status_separacao: "aguardando_compra",
    separacao_galpao_id: empresa.galpaoId,
    compraStatusItem: "aguardando_compra",
    marcadores: ["PORTADO", "OC", empresa.galpaoNome, "LVR"],
  });
}

async function main() {
  const file = resolve(process.cwd(), "scripts/wms/_pedidos-antigos.json");
  let rows: OldPedido[] = JSON.parse(readFileSync(file, "utf8"));
  if (onlyIds) rows = rows.filter((r) => onlyIds.has(r.id));
  if (limit) rows = rows.slice(0, limit);

  if (APPLY && !ALLOW) {
    console.error("✖ --apply exige ALLOW_PORT=true no env. Abortando (trava de segurança).");
    process.exit(1);
  }

  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} modo=${modoArg} — ${rows.length} pedido(s) | DB: ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);

  const contagem: Record<string, number> = {};
  let importados = 0;
  let falhas = 0;

  for (const old of rows) {
    const empresa = await getEmpresaById(old.empresa_origem_id);
    if (!empresa) {
      console.log(`SEM_EMPRESA            ${old.numero} (empresa ${old.empresa_origem_id} não existe no novo)`);
      contagem.SEM_EMPRESA = (contagem.SEM_EMPRESA ?? 0) + 1;
      continue;
    }
    const { plano } = await planejar(old, empresa, APPLY);
    contagem[plano.classe] = (contagem[plano.classe] ?? 0) + 1;

    console.log(`${plano.classe.padEnd(12)} ${old.numero.padEnd(8)} ${old.status_separacao.padEnd(20)} ${plano.detalhe}`);

    if (!APPLY) continue;
    const querSep = modoArg === "todos" || modoArg === "separacao";
    const querCompra = modoArg === "todos" || modoArg === "compra";
    try {
      if (plano.classe === "SEPARACAO" && plano.rota && querSep) {
        await importarSeparacao(old, empresa, plano.rota);
        importados++;
        console.log(`    ✓ importado (aguardando_separacao + reserva)`);
      } else if (plano.classe === "COMPRA" && querCompra) {
        await importarCompra(old, empresa);
        importados++;
        console.log(`    ✓ importado (aguardando_compra / aba de compras)`);
      }
    } catch (e) {
      falhas++;
      console.error(`    ✖ falha: ${(e as Error).message}`);
    }
  }

  console.log("\n── Resumo por classe ──");
  for (const [classe, n] of Object.entries(contagem)) console.log(`  ${classe.padEnd(12)} ${n}`);
  if (APPLY) console.log(`\nImportados: ${importados} | Falhas: ${falhas}`);
  else console.log(`\nDRY-RUN. Aplicar: ALLOW_PORT=true npx tsx scripts/wms/portar-pedidos-antigos.ts --apply [--modo=separacao|compra]`);
}

main().then(() => process.exit(0));

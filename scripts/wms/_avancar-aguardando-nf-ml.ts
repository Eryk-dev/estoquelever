#!/usr/bin/env tsx
/**
 * One-off (incidente downtime 2026-06-27/28): pedidos travados em
 * `aguardando_nf` porque os jobs `lancar_estoque` morreram na corrida de
 * refresh do Tiny OAuth (invalid_grant). A NF foi emitida MANUALMENTE no Tiny,
 * mas o SISO não linkou. Em vez de esperar o polling, usamos o ML como fonte
 * de verdade: se a etiqueta do shipment já está PRONTA PRA IMPRESSÃO
 * (substatus ready_to_print/printed, ou status shipped/delivered), a NF está
 * autorizada → avançamos aguardando_nf → aguardando_separacao.
 *
 * READ-ONLY por padrão (só consulta o ML e reporta). Passe --apply pra mutar.
 *
 *   npx tsx scripts/wms/_avancar-aguardando-nf-ml.ts            # dry-run
 *   npx tsx scripts/wms/_avancar-aguardando-nf-ml.ts --apply    # aplica
 *   ...adicione --todos pra ignorar o filtro de "envia hoje"
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentStatus,
  getMlShipmentStatusById,
} from "../../src/lib/ml-api";

const APPLY = process.argv.includes("--apply");
const TODOS = process.argv.includes("--todos");

const READY_SUBSTATUS = new Set(["ready_to_print", "printed", "picked_up"]);
const READY_STATUS = new Set(["shipped", "delivered"]);

interface Pedido {
  id: string;
  empresa_origem_id: string | null;
  status: string;
  status_separacao: string | null;
  id_pedido_ecommerce: string | null;
  ml_shipment_id: string | null;
  nome_ecommerce: string | null;
}

function etiquetaPronta(status: string | null, substatus: string | null): boolean {
  if (substatus && READY_SUBSTATUS.has(substatus)) return true;
  if (status && READY_STATUS.has(status)) return true;
  return false;
}

async function main() {
  const sb = createServiceClient();

  let q = sb
    .from("siso_pedidos")
    .select(
      "id, empresa_origem_id, status, status_separacao, id_pedido_ecommerce, ml_shipment_id, nome_ecommerce, prazo_envio",
    )
    .eq("status_separacao", "aguardando_nf")
    .not("id_pedido_ecommerce", "is", null);

  const { data, error } = await q;
  if (error) throw new Error(`query falhou: ${error.message}`);

  let pedidos = (data ?? []) as (Pedido & { prazo_envio: string | null })[];

  // Só ML (tem id_pedido_ecommerce + nome de canal ML). Shopee não tem shipment ML.
  pedidos = pedidos.filter((p) => /mercado livre|mercadolivre|ml[_ ]/i.test(p.nome_ecommerce ?? ""));

  // Filtro "envia hoje" (BRT) salvo --todos.
  if (!TODOS) {
    const hojeBrt = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    pedidos = pedidos.filter((p) => {
      if (!p.prazo_envio) return false;
      const d = new Date(new Date(p.prazo_envio).getTime() - 3 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      return d === hojeBrt;
    });
  }

  console.log(`\n${pedidos.length} pedido(s) em aguardando_nf (ML${TODOS ? "" : ", envia hoje"})`);
  console.log(`modo: ${APPLY ? "APPLY (vai mutar)" : "DRY-RUN (só leitura)"}\n`);

  // Cache de connectionId por empresa.
  const connCache = new Map<string, string | null>();
  async function conn(empresaId: string): Promise<string | null> {
    if (!connCache.has(empresaId)) {
      connCache.set(empresaId, await getActiveMlConnectionForEmpresa(empresaId));
    }
    return connCache.get(empresaId) ?? null;
  }

  const prontos: Pedido[] = [];
  const naoProntos: Array<{ p: Pedido; status: string | null; substatus: string | null }> = [];
  const semInfo: Array<{ p: Pedido; motivo: string }> = [];

  for (const p of pedidos) {
    if (!p.empresa_origem_id) {
      semInfo.push({ p, motivo: "sem empresa_origem_id" });
      continue;
    }
    const connectionId = await conn(p.empresa_origem_id);
    if (!connectionId) {
      semInfo.push({ p, motivo: "empresa sem conexão ML ativa" });
      continue;
    }

    try {
      let res: { status: string | null; substatus: string | null } | null = null;
      if (p.ml_shipment_id) {
        res = await getMlShipmentStatusById(connectionId, p.ml_shipment_id);
      } else {
        const r = await getMlShipmentStatus(connectionId, p.id_pedido_ecommerce!);
        if (r) res = { status: r.status, substatus: r.substatus };
      }

      if (!res) {
        semInfo.push({ p, motivo: "ML não retornou shipment (null)" });
        continue;
      }

      const pronto = etiquetaPronta(res.status, res.substatus);
      const linha = `  ${p.id}  ${(p.nome_ecommerce ?? "").padEnd(18)}  status=${res.status ?? "-"}  substatus=${res.substatus ?? "-"}  ${pronto ? "✅ PRONTA" : "⏳"}`;
      console.log(linha);
      if (pronto) prontos.push(p);
      else naoProntos.push({ p, status: res.status, substatus: res.substatus });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      semInfo.push({ p, motivo: `erro ML: ${msg}` });
      console.log(`  ${p.id}  ERRO ML: ${msg}`);
    }
  }

  console.log(`\n── resumo ──`);
  console.log(`✅ etiqueta pronta (avançáveis): ${prontos.length}`);
  console.log(`⏳ ainda não prontas: ${naoProntos.length}`);
  console.log(`⚠️  sem info/erro: ${semInfo.length}`);
  if (naoProntos.length) {
    console.log(`\nnão prontas (status/substatus):`);
    for (const n of naoProntos) console.log(`  ${n.p.id}  ${n.status ?? "-"}/${n.substatus ?? "-"}`);
  }
  if (semInfo.length) {
    console.log(`\nsem info:`);
    for (const s of semInfo) console.log(`  ${s.p.id}  ${s.motivo}`);
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — nada mutado. Rode com --apply pra avançar os ${prontos.length} prontos.\n`);
    return;
  }

  if (prontos.length === 0) {
    console.log(`\nnada pra avançar.\n`);
    return;
  }

  console.log(`\n── APLICANDO em ${prontos.length} pedido(s) ──`);
  let ok = 0;
  for (const p of prontos) {
    // 1. avança status_separacao + limpa status=erro (NF já existe no ML/Tiny)
    const upd: Record<string, unknown> = {
      status_separacao: "aguardando_separacao",
      atualizado_em: new Date().toISOString(),
    };
    if (p.status === "erro") {
      upd.status = "concluido";
      upd.erro = null;
    }
    const { error: e1 } = await sb
      .from("siso_pedidos")
      .update(upd)
      .eq("id", p.id)
      .eq("status_separacao", "aguardando_nf"); // guarda contra corrida
    if (e1) {
      console.log(`  ${p.id}  FALHA update pedido: ${e1.message}`);
      continue;
    }
    // 2. encerra o job lancar_estoque morto (NF resolvida externamente)
    await sb
      .from("siso_fila_execucao")
      .update({ status: "concluido", atualizado_em: new Date().toISOString() })
      .eq("pedido_id", p.id)
      .eq("tipo", "lancar_estoque")
      .eq("status", "erro");
    ok++;
    console.log(`  ${p.id}  ✅ avançado pra aguardando_separacao`);
  }
  console.log(`\n${ok}/${prontos.length} avançados.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * ONE-OFF (2026-06-25): os 8 OC futura de envio-hoje foram tirados da pista
 * futura (promover-futura-2026-06-25.ts) mas NÃO ganharam NF + agrupamento — o
 * flip da flag não enfileira lancar_estoque. Correção de design: ao liberar a
 * etiqueta, TUDO gera NF + agrupamento igual ao fluxo normal (inclusive OC).
 *
 * Ação: enfileira lancar_estoque (decisao=oc) pra cada um via promoverPedidoFutura
 * (flip já-false = no-op; enfileira se não houver job pendente/executando; kicka).
 * O worker (executarMarcadoresOnly, !futura) emite a NF + agrupamento e segue a
 * compra. gerarNotaFiscalPedido é idempotente (reusa NF do 946497468).
 *
 * Rodar: npx tsx scripts/wms/remediar-oc-futura-nf-2026-06-25.ts
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { promoverPedidoFutura } from "../../src/lib/webhook-processor-wms";

const OC = ["1046460975", "946497468", "1046366943", "952749995", "952752782", "1046361670", "1046434230", "1046468419"];

async function main() {
  const sb = createServiceClient();

  const { data: galpoes } = await sb.from("siso_galpoes").select("id, nome");
  const nomeGalpao = new Map(((galpoes ?? []) as Array<{ id: string; nome: string }>).map((g) => [g.id, g.nome]));

  const { data: peds } = await sb
    .from("siso_pedidos")
    .select("id, decisao_final, separacao_futura, empresa_origem_id, separacao_galpao_id, chave_acesso_nf, agrupamento_expedicao_id")
    .in("id", OC);

  type Row = {
    id: string; decisao_final: string | null; separacao_futura: boolean;
    empresa_origem_id: string | null; separacao_galpao_id: string | null;
    chave_acesso_nf: string | null; agrupamento_expedicao_id: number | null;
  };
  console.log("Antes:");
  for (const p of (peds ?? []) as Row[]) {
    console.log(`  ${p.id} | dec=${p.decisao_final} | futura=${p.separacao_futura} | nf=${p.chave_acesso_nf ? "sim" : "—"} | agrup=${p.agrupamento_expedicao_id ?? "—"}`);
  }

  let ok = 0;
  for (const p of (peds ?? []) as Row[]) {
    const r = await promoverPedidoFutura(sb, {
      pedidoId: p.id,
      decisaoFinal: p.decisao_final,
      galpaoNome: p.separacao_galpao_id ? nomeGalpao.get(p.separacao_galpao_id) ?? null : null,
      empresaId: p.empresa_origem_id,
    });
    console.log(`  → ${p.id}: enfileirou=${r.enfileirouLancamento}`);
    if (r.enfileirouLancamento) ok++;
  }
  console.log(`\n✔ ${ok}/${OC.length} enfileiraram lancar_estoque. O worker gera NF + agrupamento + segue a compra.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", e); process.exit(1); });

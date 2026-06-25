/**
 * ONE-OFF (2026-06-25): tira da pista FUTURA os pedidos de envio hoje que
 * travaram (etiqueta já liberou no ML — invoice_pending/ready_to_ship — mas a
 * promoção nunca disparou; ver erros-conhecidos.yaml SEP-FUTURA-PROMO).
 *
 * Ação: flipa `separacao_futura=false` → caem na separação NORMAL.
 *   - 5 prontos (propria/transferência): já têm NF + reserva → picam e enviam.
 *   - 8 OC sem estoque: ficam visíveis como pendentes (sem peça pra picar).
 * NÃO enfileira lancar_estoque (os 5 já têm NF emitida — regerar = NF dobrada).
 *
 * Idempotente: flipar de novo é no-op (flag já false).
 * Rodar: npx tsx scripts/wms/promover-futura-2026-06-25.ts
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";

const PRONTOS = ["946457694", "946464694", "946495186", "946496243", "938397946"];
const OC_SEM_ESTOQUE = ["1046460975", "946497468", "1046366943", "952749995", "952752782", "1046361670", "1046434230", "1046468419"];
const TODOS = [...PRONTOS, ...OC_SEM_ESTOQUE];

async function main() {
  const sb = createServiceClient();

  const { data: antes } = await sb
    .from("siso_pedidos")
    .select("id, separacao_futura, status, status_separacao, decisao_final, chave_acesso_nf")
    .in("id", TODOS);
  console.log(`Alvo: ${TODOS.length} pedidos (${PRONTOS.length} prontos + ${OC_SEM_ESTOQUE.length} OC).`);
  console.log("Antes:");
  type Row = {
    id: string;
    separacao_futura: boolean;
    status: string;
    status_separacao: string | null;
    decisao_final: string | null;
    chave_acesso_nf: string | null;
  };
  for (const p of (antes ?? []) as Row[]) {
    console.log(`  ${p.id} | futura=${p.separacao_futura} | ${p.status}/${p.status_separacao} | ${p.decisao_final} | nf=${p.chave_acesso_nf ? "sim" : "—"}`);
  }

  const { data: upd, error } = await sb
    .from("siso_pedidos")
    .update({ separacao_futura: false })
    .in("id", TODOS)
    .eq("separacao_futura", true)
    .select("id");
  if (error) throw error;
  console.log(`\n✔ Flipados: ${upd?.length ?? 0} pedidos → separacao_futura=false`);

  const { count } = await sb
    .from("siso_pedidos")
    .select("*", { count: "exact", head: true })
    .in("id", TODOS)
    .eq("separacao_futura", true);
  console.log(`Restantes ainda futura (deve ser 0): ${count ?? "?"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", e); process.exit(1); });

/**
 * Backfill one-off: puxa do Tiny todos os produtos CRIADOS desde uma data
 * (default: último sábado 2026-06-13) em TODAS as contas conectadas e cadastra
 * no catálogo (siso_produtos) os que ainda não existem. Catch-up do gap antes
 * do cron de 1 min (wms_tiny_sync_produtos). Produto já existente é só contado
 * (não re-sincroniza — o cron mantém). Kits puxam componentes automático
 * (sincronizarComposicaoKit → ensureComponenteCatalogo).
 *
 *   tsx scripts/wms/backfill-produtos-desde.ts                 # dry-run (só lista)
 *   tsx scripts/wms/backfill-produtos-desde.ts --apply         # cadastra
 *   tsx scripts/wms/backfill-produtos-desde.ts 2026-06-13 --apply
 *
 * Idempotente. Estoque não é tocado (WMS é a fonte única).
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { listarProdutos } from "../../src/lib/tiny-api";
import { getValidTokenByEmpresa } from "../../src/lib/tiny-oauth";
import { runWithEmpresa } from "../../src/lib/tiny-queue";
import { ensureProdutoFromTiny } from "../../src/lib/wms/sync-tiny";

const APPLY = process.argv.includes("--apply");
const dateArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const DESDE = dateArg ?? "2026-06-13"; // último sábado (hoje = qui 2026-06-18)
const CUTOFF = `${DESDE} 00:00:00`;
const PAGE = 100;
const MAX_PAGES = 200; // trava anti-loop (20k produtos/conta)

async function main() {
  const sb = createServiceClient();

  const { data: conns, error } = await sb
    .from("siso_tiny_connections")
    .select("cnpj, empresa_id")
    .eq("ativo", true)
    .not("empresa_id", "is", null)
    .not("access_token", "is", null);
  if (error) throw new Error(`conexões: ${error.message}`);
  const { data: emp } = await sb
    .from("siso_empresas")
    .select("id, nome")
    .eq("ativo", true);
  const nomePorId = new Map(
    (emp ?? []).map((e) => [(e as { id: string }).id, (e as { nome: string }).nome]),
  );
  const ativas = new Set((emp ?? []).map((e) => (e as { id: string }).id));
  const lista = ((conns ?? []) as Array<{ cnpj: string; empresa_id: string }>).filter(
    (c) => ativas.has(c.empresa_id),
  );

  console.log(
    `\nBackfill produtos criados desde ${CUTOFF} · ${APPLY ? "APPLY" : "DRY-RUN"} · ${lista.length} contas\n`,
  );

  let tV = 0,
    tN = 0,
    tE = 0,
    tC = 0,
    tErr = 0;
  for (const conn of lista) {
    const nome = nomePorId.get(conn.empresa_id) ?? conn.cnpj;
    let vistos = 0,
      novos = 0,
      exist = 0,
      criados = 0,
      erros = 0;
    try {
      const { token } = await getValidTokenByEmpresa(conn.empresa_id);
      await runWithEmpresa(conn.empresa_id, async () => {
        let offset = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await listarProdutos(token, {
            situacao: "A",
            dataCriacao: CUTOFF,
            limit: PAGE,
            offset,
          });
          const itens = res.itens ?? [];
          for (const it of itens) {
            const sku = it.sku?.trim();
            if (!sku || it.id == null) continue;
            vistos++;
            const { data: ex } = await sb
              .from("siso_produtos")
              .select("id")
              .eq("sku", sku)
              .maybeSingle();
            if (ex) {
              exist++;
              continue;
            }
            novos++;
            if (APPLY) {
              try {
                await ensureProdutoFromTiny(sku, conn.empresa_id, it.id);
                criados++;
              } catch (e) {
                erros++;
                console.error(`  ! ${sku}: ${e instanceof Error ? e.message : String(e)}`);
              }
            } else {
              console.log(`  + ${sku} — ${(it.descricao ?? "").slice(0, 70)}`);
            }
          }
          if (itens.length < PAGE) break;
          offset += PAGE;
          if (page === MAX_PAGES - 1) {
            console.warn(`  [${nome}] MAX_PAGES atingido — pode haver mais`);
          }
        }
      });
    } catch (e) {
      console.error(`[${nome}] ERRO: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log(
      `[${nome}] vistos=${vistos} novos=${novos} jaExistiam=${exist}` +
        (APPLY ? ` criados=${criados} erros=${erros}` : ""),
    );
    tV += vistos;
    tN += novos;
    tE += exist;
    tC += criados;
    tErr += erros;
  }

  console.log(
    `\nTOTAL: vistos=${tV} novos=${tN} jaExistiam=${tE}` +
      (APPLY
        ? ` criados=${tC} erros=${tErr}`
        : `  (dry-run — rode com --apply pra cadastrar os ${tN} novos)`),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

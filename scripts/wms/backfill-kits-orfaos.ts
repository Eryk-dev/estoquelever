/**
 * Backfill: kits ÓRFÃOS (siso_produtos.eh_kit=true SEM nenhuma linha em
 * siso_produto_kits). Esses kits foram criados antes do guard de 2026-06-05
 * (wms-kit-sem-componente) e ficaram sem composição → roteiam sempre pra OC e
 * estouram no "Encontrei" (contagem inline faz mov E no SKU-kit → trigger
 * trg_check_mov_nao_kit_entrada rejeita).
 *
 * Pra cada órfão: busca a composição ATUAL no Tiny (getProdutoFull.kit), resolve
 * cada componente → produto_id WMS (por tiny_produto_id em qualquer empresa,
 * fallback SKU em siso_produtos) e popula siso_produto_kits. eh_kit fica true só
 * com ≥1 componente; Tiny tipo!='K' (mis-flag) → eh_kit=false.
 *
 *   tsx scripts/wms/backfill-kits-orfaos.ts                 # dry-run (só mostra)
 *   tsx scripts/wms/backfill-kits-orfaos.ts --apply         # grava
 *   tsx scripts/wms/backfill-kits-orfaos.ts --only=KLL013   # 1 SKU (dry ou apply)
 *
 * Idempotente: re-rodar só completa o que faltou (insere componente ausente).
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { getProdutoFull } from "../../src/lib/tiny-api";
import { getValidTokenByEmpresa } from "../../src/lib/tiny-oauth";
import { runWithEmpresa } from "../../src/lib/tiny-queue";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? null;

type Mapeamento = { empresa_id: string; tiny_produto_id: number };
type Orfao = { id: string; sku: string; descricao: string | null; mapeamentos: Mapeamento[] };
type Categoria =
  | "completo"            // todos componentes do Tiny resolvidos
  | "parcial"             // alguns resolvidos, outros faltando no catálogo
  | "nao_kit_no_tiny"     // Tiny tipo != 'K' → mis-flag → unflag
  | "kit_vazio_tiny"      // tipo=K mas Tiny não devolve composição
  | "sem_match_catalogo"  // tipo=K, tem composição, mas NENHUM componente no catálogo
  | "sem_token"           // empresa sem mapeamento utilizável
  | "erro";

async function resolverComponente(
  sb: ReturnType<typeof createServiceClient>,
  tinyId: number,
  sku: string | null,
): Promise<string | null> {
  // 1) por tiny_produto_id (qualquer empresa) — chave mais forte
  const { data: porTiny } = await sb
    .from("siso_produto_empresas")
    .select("produto_id")
    .eq("tiny_produto_id", tinyId)
    .limit(1)
    .maybeSingle();
  if (porTiny) return (porTiny as { produto_id: string }).produto_id;
  // 2) fallback por SKU em siso_produtos
  if (sku) {
    const { data: porSku } = await sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .limit(1)
      .maybeSingle();
    if (porSku) return (porSku as { id: string }).id;
  }
  return null;
}

async function main() {
  const sb = createServiceClient();

  // Órfãos: eh_kit=true sem composição.
  // PostgREST limita a 1000 linhas/request → pagina com .range() senão o Set
  // fica incompleto e kits COM composição (linhas além da 1000) viram falsos
  // órfãos.
  const comComposicao = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: pagina } = await sb
      .from("siso_produto_kits")
      .select("kit_produto_id")
      .range(from, from + PAGE - 1);
    const linhas = (pagina ?? []) as Array<{ kit_produto_id: string }>;
    for (const l of linhas) comComposicao.add(l.kit_produto_id);
    if (linhas.length < PAGE) break;
  }

  // Pagina também o fetch de eh_kit=true (>1000 produtos → capa em 1000).
  const kits: Array<{ id: string; sku: string; descricao: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from("siso_produtos").select("id, sku, descricao").eq("eh_kit", true);
    if (ONLY) q = q.eq("sku", ONLY);
    const { data: pagina, error } = await q
      .range(from, from + PAGE - 1)
      .returns<Array<{ id: string; sku: string; descricao: string | null }>>();
    if (error) throw new Error(error.message);
    const linhas = pagina ?? [];
    kits.push(...linhas);
    if (linhas.length < PAGE) break;
  }

  const orfaos: Orfao[] = [];
  for (const k of kits) {
    if (comComposicao.has(k.id)) continue;
    const { data: maps } = await sb
      .from("siso_produto_empresas")
      .select("empresa_id, tiny_produto_id")
      .eq("produto_id", k.id)
      .eq("ativo", true)
      .returns<Mapeamento[]>();
    orfaos.push({ ...k, mapeamentos: maps ?? [] });
  }

  console.log(`${orfaos.length} kit(s) órfão(s)${ONLY ? ` (filtro --only=${ONLY})` : ""}\n`);
  console.log(APPLY ? "MODO: APPLY (grava)\n" : "MODO: DRY-RUN (use --apply pra gravar)\n");

  const resumo: Record<Categoria, number> = {
    completo: 0, parcial: 0, nao_kit_no_tiny: 0, kit_vazio_tiny: 0,
    sem_match_catalogo: 0, sem_token: 0, erro: 0,
  };
  const residual: Array<{ sku: string; cat: Categoria; detalhe: string }> = [];

  for (const orf of orfaos) {
    const mapa = orf.mapeamentos[0];
    if (!mapa) {
      resumo.sem_token++;
      residual.push({ sku: orf.sku, cat: "sem_token", detalhe: "sem mapeamento Tiny ativo" });
      console.log(`  ⚠️  ${orf.sku}: sem mapeamento Tiny ativo`);
      continue;
    }

    let cat: Categoria;
    let detalhe = "";
    try {
      const { token } = await getValidTokenByEmpresa(mapa.empresa_id);
      const full = await runWithEmpresa(mapa.empresa_id, () =>
        getProdutoFull(token, mapa.tiny_produto_id),
      );

      if (full.tipo !== "K") {
        cat = "nao_kit_no_tiny";
        detalhe = `Tiny tipo='${full.tipo}'`;
        if (APPLY) {
          await sb.from("siso_produtos").update({ eh_kit: false }).eq("id", orf.id);
        }
      } else if (full.kit.length === 0) {
        cat = "kit_vazio_tiny";
        detalhe = "Tiny tipo=K mas /produtos retornou kit[] vazio";
      } else {
        const linhas: Array<{ kit_produto_id: string; componente_produto_id: string; quantidade: number }> = [];
        const faltando: string[] = [];
        for (const item of full.kit) {
          const compId = await resolverComponente(sb, item.produto.id, item.produto.sku);
          if (!compId) {
            faltando.push(item.produto.sku ?? String(item.produto.id));
            continue;
          }
          if (compId === orf.id) continue; // anti-recursão
          linhas.push({ kit_produto_id: orf.id, componente_produto_id: compId, quantidade: item.quantidade });
        }

        if (linhas.length === 0) {
          cat = "sem_match_catalogo";
          detalhe = `${full.kit.length} componente(s) no Tiny, 0 no catálogo: ${faltando.join(", ")}`;
        } else {
          cat = faltando.length > 0 ? "parcial" : "completo";
          detalhe = `${linhas.length} componente(s)` + (faltando.length ? ` | faltando no catálogo: ${faltando.join(", ")}` : "");
          if (APPLY) {
            // upsert idempotente (PK lógica kit+componente). Garante eh_kit=true.
            const { error: errIns } = await sb
              .from("siso_produto_kits")
              .upsert(linhas, { onConflict: "kit_produto_id,componente_produto_id" });
            if (errIns) throw new Error(`insert composição: ${errIns.message}`);
            await sb.from("siso_produtos").update({ eh_kit: true }).eq("id", orf.id);
          }
        }
      }
    } catch (e) {
      cat = "erro";
      detalhe = (e as Error).message;
    }

    resumo[cat]++;
    if (cat !== "completo") residual.push({ sku: orf.sku, cat, detalhe });
    const icon = cat === "completo" ? "✅" : cat === "parcial" ? "🟡" : cat === "nao_kit_no_tiny" ? "🔧" : "❌";
    console.log(`  ${icon} ${orf.sku} [${cat}] ${detalhe}  — ${(orf.descricao ?? "").slice(0, 50)}`);
  }

  console.log("\n── RESUMO ──");
  for (const [cat, n] of Object.entries(resumo)) if (n > 0) console.log(`  ${cat}: ${n}`);
  if (residual.length) {
    console.log("\n── RESIDUAL (precisa de ação manual) ──");
    for (const r of residual) console.log(`  ${r.sku} [${r.cat}] ${r.detalhe}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

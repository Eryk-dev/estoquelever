import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";

/**
 * GET /api/wms/saldo-recebimento-orfao?galpao_id=<uuid>
 *
 * Lista saldos em locs `tipo='recebimento'` que NÃO têm pendência de guarda
 * ativa (`pendente` ou `em_guarda`). Sinaliza saldo fantasma: a peça chegou
 * no dock mas a pendência foi cancelada antes do put-away — o saldo continua
 * "preso" no RECEBIMENTO e ninguém vai endereçá-lo.
 *
 * Consumido pelo card de alerta na home /wms (P5).
 *
 * Query params:
 *   - galpao_id (opcional): filtra por galpão.
 *
 * Response: { itens: ItemOrfao[] } onde
 *   ItemOrfao = { produto_id, sku, descricao, galpao_id, localizacao_id,
 *                 localizacao_codigo, saldo, pendente_total, orfao }
 */
export async function GET(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const galpaoId = req.nextUrl.searchParams.get("galpao_id");

  const sb = createServiceClient();

  // 1. Locs tipo='recebimento' do galpão (ou todos se galpao_id ausente)
  let locQuery = sb
    .from("siso_localizacoes")
    .select("id, codigo, galpao_id")
    .eq("tipo", "recebimento")
    .eq("ativo", true);
  if (galpaoId) locQuery = locQuery.eq("galpao_id", galpaoId);
  const { data: locsRec } = await locQuery;
  const locIds = (locsRec ?? []).map((l) => l.id as string);
  if (locIds.length === 0) return NextResponse.json({ itens: [] });

  // 2. Saldos > 0 nessas locs
  const { data: saldos } = await sb
    .from("siso_estoque")
    .select("produto_id, galpao_id, localizacao_id, saldo, disponivel")
    .in("localizacao_id", locIds)
    .gt("saldo", 0);

  const saldosArr = (saldos ?? []) as Array<{
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    saldo: number;
    disponivel: number;
  }>;
  if (saldosArr.length === 0) return NextResponse.json({ itens: [] });

  // 3. Pendências ativas em cada (produto, loc) — agrega qty
  const { data: pends } = await sb
    .from("siso_wms_pendencias_guarda")
    .select("produto_id, localizacao_origem_id, qty_pendente")
    .in("status", ["pendente", "em_guarda"])
    .in("localizacao_origem_id", locIds);

  const pendIndex = new Map<string, number>();
  for (const p of (pends ?? []) as Array<{
    produto_id: string;
    localizacao_origem_id: string;
    qty_pendente: number;
  }>) {
    const key = `${p.produto_id}|${p.localizacao_origem_id}`;
    pendIndex.set(key, (pendIndex.get(key) ?? 0) + Number(p.qty_pendente));
  }

  // 4. Resolve produtos + locs metadata
  const produtoIds = [...new Set(saldosArr.map((s) => s.produto_id))];
  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao")
    .in("id", produtoIds);
  const prodMap = new Map(
    ((produtos ?? []) as Array<{ id: string; sku: string; descricao: string }>).map(
      (p) => [p.id, p],
    ),
  );
  const locMap = new Map(
    ((locsRec ?? []) as Array<{ id: string; codigo: string; galpao_id: string }>).map(
      (l) => [l.id, l],
    ),
  );

  const itens: Array<{
    produto_id: string;
    sku: string;
    descricao: string;
    galpao_id: string;
    localizacao_id: string;
    localizacao_codigo: string;
    saldo: number;
    pendente_total: number;
    orfao: number;
  }> = [];
  for (const s of saldosArr) {
    const key = `${s.produto_id}|${s.localizacao_id}`;
    const pendQty = pendIndex.get(key) ?? 0;
    const orfao = Number(s.saldo) - pendQty;
    if (orfao > 0) {
      const prod = prodMap.get(s.produto_id);
      const loc = locMap.get(s.localizacao_id);
      if (!prod || !loc) continue;
      itens.push({
        produto_id: s.produto_id,
        sku: prod.sku,
        descricao: prod.descricao,
        galpao_id: s.galpao_id,
        localizacao_id: s.localizacao_id,
        localizacao_codigo: loc.codigo,
        saldo: Number(s.saldo),
        pendente_total: pendQty,
        orfao,
      });
    }
  }

  return NextResponse.json({ itens });
}

#!/usr/bin/env tsx
/**
 * scripts/wms/check-nfs-hoje.ts — diagnóstico one-off (2026-06-12).
 * Lista NFs EasyPeasy emitidas hoje no Tiny com numero > 019974 (as 16
 * NFs legítimas da recovery foram 019959–019974; acima disso = candidatas
 * a duplicata geradas pelos jobs dos pedidos já atendidos no sistema
 * antigo). Read-only.
 *
 * Rodar: npx tsx scripts/wms/check-nfs-hoje.ts
 */

import "dotenv/config";
import { getValidTokenByEmpresa } from "../../src/lib/tiny-oauth";
import { runWithEmpresa } from "../../src/lib/tiny-queue";
import { listarNotas, type TinyNotaListItem } from "../../src/lib/tiny-api";

const EASYPEASY = "818f5445-6704-4045-9179-068ba507d480";

async function main() {
  const { token } = await getValidTokenByEmpresa(EASYPEASY);
  const todas: TinyNotaListItem[] = [];
  for (let page = 0; page < 10; page++) {
    const { itens } = await runWithEmpresa(EASYPEASY, () =>
      listarNotas(token, { dataInicial: "2026-06-12", limit: 100, offset: page * 100 }),
    );
    const lote = itens ?? [];
    todas.push(...lote);
    if (lote.length < 100) break;
  }
  console.log(`NFs de hoje: ${todas.length}`);
  for (const nf of todas) {
    const num = parseInt(String(nf.numero), 10);
    if (num > 19974) {
      console.log(JSON.stringify({ id: nf.id, numero: nf.numero, situacao: nf.situacao, dataEmissao: nf.dataEmissao }));
    }
  }
}

main().then(() => process.exit(0));

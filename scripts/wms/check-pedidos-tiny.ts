#!/usr/bin/env tsx
/**
 * scripts/wms/check-pedidos-tiny.ts — diagnóstico one-off (2026-06-12).
 * Lista TODOS os pedidos EasyPeasy no Tiny desde 2026-05-20 (sem filtro de
 * situação), imprime a situação atual dos pedidos perdidos no incidente e
 * os ids de todos os aprovados. Read-only.
 *
 * Rodar: npx tsx scripts/wms/check-pedidos-tiny.ts
 */

import "dotenv/config";
import { getValidTokenByEmpresa } from "../../src/lib/tiny-oauth";
import { runWithEmpresa } from "../../src/lib/tiny-queue";
import { listarPedidos, type TinyPedidoListItem } from "../../src/lib/tiny-api";

const EASYPEASY = "818f5445-6704-4045-9179-068ba507d480";

const PERDIDOS = [
  "937845304",
  "937864604",
  "937914844",
  "937940965",
  "938039226",
  "938066405",
  "938069617",
  "938078618",
  "938084558",
  "938086309",
  "938237249",
];

async function main() {
  const { token } = await getValidTokenByEmpresa(EASYPEASY);
  const todos: TinyPedidoListItem[] = [];
  for (let page = 0; page < 80; page++) {
    const { itens } = await runWithEmpresa(EASYPEASY, () =>
      listarPedidos(token, {
        dataInicial: "2026-05-20",
        limit: 100,
        offset: page * 100,
      }),
    );
    const lote = itens ?? [];
    todos.push(...lote);
    if (lote.length < 100) break;
  }

  console.log(`total pedidos desde 2026-05-20: ${todos.length}`);
  const porId = new Map(todos.map((p) => [String(p.id), p]));

  console.log("\n── situação atual dos perdidos ──");
  for (const id of PERDIDOS) {
    const p = porId.get(id);
    console.log(`${id}: situacao=${p ? p.situacao : "NAO LISTADO"}`);
  }

  const aprovados = todos.filter((p) => String(p.situacao) === "3");
  console.log(`\n── aprovados (situacao=3): ${aprovados.length} ──`);
  console.log(aprovados.map((p) => String(p.id)).join(","));
}

main().then(() => process.exit(0));

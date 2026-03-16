import type { Cargo, Decisao, Pedido } from "@/types";

/** Maps cargo to its galpão name. Returns null for roles that see all galpões. */
function cargoToGalpao(cargo: Cargo): string | null {
  if (cargo === "operador_cwb") return "CWB";
  if (cargo === "operador_sp") return "SP";
  return null;
}

/**
 * Filters pending orders based on user role.
 *
 * - admin: sees all
 * - operador_*: sees orders where filialOrigem matches their galpão
 * - comprador: sees only orders with sugestao=oc
 */
export function filtrarPendentes(pedidos: Pedido[], cargo: Cargo): Pedido[] {
  if (cargo === "admin") return pedidos;
  if (cargo === "comprador") return pedidos.filter((p) => p.sugestao === "oc");

  const galpao = cargoToGalpao(cargo);
  if (!galpao) return pedidos;
  return pedidos.filter((p) => p.filialOrigem === galpao);
}

/**
 * Filters completed orders based on user role.
 *
 * - admin: sees all
 * - operador_*: sees orders fulfilled by their galpão
 * - comprador: sees only OC decisions
 */
export function filtrarConcluidos(pedidos: Pedido[], cargo: Cargo): Pedido[] {
  if (cargo === "admin") return pedidos;
  if (cargo === "comprador") return pedidos.filter((p) => (p.decisaoFinal ?? p.sugestao) === "oc");

  const galpao = cargoToGalpao(cargo);
  if (!galpao) return pedidos;
  return pedidos.filter((p) => {
    const decisao: Decisao = p.decisaoFinal ?? p.sugestao;
    if (decisao === "propria") return p.filialOrigem === galpao;
    if (decisao === "transferencia") return p.filialOrigem !== galpao;
    return false;
  });
}

/**
 * Filters auto-approved orders based on user role.
 *
 * - admin: sees all
 * - operador_*: auto-approved from their galpão
 * - comprador: empty (OC is never auto)
 */
export function filtrarAuto(pedidos: Pedido[], cargo: Cargo): Pedido[] {
  if (cargo === "admin") return pedidos;
  if (cargo === "comprador") return [];

  const galpao = cargoToGalpao(cargo);
  if (!galpao) return pedidos;
  return pedidos.filter((p) => p.filialOrigem === galpao);
}

import type { Cargo, Decisao, Pedido } from "@/types";

/**
 * Filters pending orders based on user role.
 *
 * - admin: sees all
 * - operador_cwb: sees orders where filialOrigem=CWB (they decide)
 * - operador_sp: sees orders where filialOrigem=SP (they decide)
 * - comprador: sees only orders with sugestao=oc
 */
export function filtrarPendentes(pedidos: Pedido[], cargo: Cargo): Pedido[] {
  if (cargo === "admin") return pedidos;

  if (cargo === "comprador") {
    return pedidos.filter((p) => p.sugestao === "oc");
  }

  const filial = cargo === "operador_cwb" ? "CWB" : "SP";
  return pedidos.filter((p) => p.filialOrigem === filial);
}

/**
 * Filters completed orders based on user role.
 *
 * - admin: sees all
 * - operador_cwb: sees orders fulfilled by CWB warehouse
 * - operador_sp: sees orders fulfilled by SP warehouse
 * - comprador: sees only OC decisions
 */
export function filtrarConcluidos(pedidos: Pedido[], cargo: Cargo): Pedido[] {
  if (cargo === "admin") return pedidos;

  if (cargo === "comprador") {
    return pedidos.filter((p) => (p.decisaoFinal ?? p.sugestao) === "oc");
  }

  const filial = cargo === "operador_cwb" ? "CWB" : "SP";
  return pedidos.filter((p) => {
    const decisao: Decisao = p.decisaoFinal ?? p.sugestao;
    if (decisao === "propria") return p.filialOrigem === filial;
    if (decisao === "transferencia") return p.filialOrigem !== filial;
    return false; // OC goes to comprador
  });
}

/**
 * Filters auto-approved orders based on user role.
 *
 * - admin: sees all
 * - operador_cwb: auto-approved from CWB
 * - operador_sp: auto-approved from SP
 * - comprador: empty (OC is never auto)
 */
export function filtrarAuto(pedidos: Pedido[], cargo: Cargo): Pedido[] {
  if (cargo === "admin") return pedidos;
  if (cargo === "comprador") return [];

  const filial = cargo === "operador_cwb" ? "CWB" : "SP";
  return pedidos.filter((p) => p.filialOrigem === filial);
}

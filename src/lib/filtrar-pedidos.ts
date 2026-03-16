import type { Cargo, Decisao, Pedido } from "@/types";

/** Maps cargo to its galpão name. Returns null for roles that see all galpões. */
function cargoToGalpao(cargo: Cargo): string | null {
  if (cargo === "operador_cwb") return "CWB";
  if (cargo === "operador_sp") return "SP";
  return null;
}

/** Normalize single cargo or array to Cargo[] */
function normalizeCargos(cargos: Cargo | Cargo[]): Cargo[] {
  return Array.isArray(cargos) ? cargos : [cargos];
}

/**
 * Filters pending orders based on user roles.
 * When user has multiple cargos, returns the union of all filtered results.
 */
export function filtrarPendentes(pedidos: Pedido[], cargos: Cargo | Cargo[]): Pedido[] {
  const roles = normalizeCargos(cargos);
  if (roles.includes("admin")) return pedidos;

  const ids = new Set<string>();
  const result: Pedido[] = [];

  for (const cargo of roles) {
    let filtered: Pedido[];
    if (cargo === "comprador") {
      filtered = pedidos.filter((p) => p.sugestao === "oc");
    } else {
      const galpao = cargoToGalpao(cargo);
      filtered = galpao ? pedidos.filter((p) => p.filialOrigem === galpao) : pedidos;
    }
    for (const p of filtered) {
      if (!ids.has(p.id)) {
        ids.add(p.id);
        result.push(p);
      }
    }
  }

  return result;
}

/**
 * Filters completed orders based on user roles.
 * When user has multiple cargos, returns the union of all filtered results.
 */
export function filtrarConcluidos(pedidos: Pedido[], cargos: Cargo | Cargo[]): Pedido[] {
  const roles = normalizeCargos(cargos);
  if (roles.includes("admin")) return pedidos;

  const ids = new Set<string>();
  const result: Pedido[] = [];

  for (const cargo of roles) {
    let filtered: Pedido[];
    if (cargo === "comprador") {
      filtered = pedidos.filter((p) => (p.decisaoFinal ?? p.sugestao) === "oc");
    } else {
      const galpao = cargoToGalpao(cargo);
      if (!galpao) {
        filtered = pedidos;
      } else {
        filtered = pedidos.filter((p) => {
          const decisao: Decisao = p.decisaoFinal ?? p.sugestao;
          if (decisao === "propria") return p.filialOrigem === galpao;
          if (decisao === "transferencia") return p.filialOrigem !== galpao;
          return false;
        });
      }
    }
    for (const p of filtered) {
      if (!ids.has(p.id)) {
        ids.add(p.id);
        result.push(p);
      }
    }
  }

  return result;
}

/**
 * Filters auto-approved orders based on user roles.
 * When user has multiple cargos, returns the union of all filtered results.
 */
export function filtrarAuto(pedidos: Pedido[], cargos: Cargo | Cargo[]): Pedido[] {
  const roles = normalizeCargos(cargos);
  if (roles.includes("admin")) return pedidos;

  const ids = new Set<string>();
  const result: Pedido[] = [];

  for (const cargo of roles) {
    if (cargo === "comprador") continue; // OC is never auto
    const galpao = cargoToGalpao(cargo);
    const filtered = galpao ? pedidos.filter((p) => p.filialOrigem === galpao) : pedidos;
    for (const p of filtered) {
      if (!ids.has(p.id)) {
        ids.add(p.id);
        result.push(p);
      }
    }
  }

  return result;
}

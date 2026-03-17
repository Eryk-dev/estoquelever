import type { Cargo, Decisao, Pedido } from "@/types";

// ─── New: Galpão-based filtering (dynamic) ─────────────────────────────────

/**
 * Filters pending orders by galpão name.
 * When galpaoNome is null, returns all (admin/all view).
 */
export function filtrarPendentesGalpao(pedidos: Pedido[], galpaoNome: string | null): Pedido[] {
  if (!galpaoNome) return pedidos;
  return pedidos.filter((p) => {
    const sugestao = p.sugestao;
    // Transferencia: quem aprova é o galpão que vai ENVIAR (o outro)
    if (sugestao === "transferencia") return p.filialOrigem !== galpaoNome;
    // Propria / OC / outros: quem aprova é o galpão de origem
    return p.filialOrigem === galpaoNome;
  });
}

/**
 * Filters completed orders by galpão name.
 * When galpaoNome is null, returns all (admin/all view).
 */
export function filtrarConcluidosGalpao(pedidos: Pedido[], galpaoNome: string | null): Pedido[] {
  if (!galpaoNome) return pedidos;
  return pedidos.filter((p) => {
    const decisao: Decisao = p.decisaoFinal ?? p.sugestao;
    if (decisao === "propria") return p.filialOrigem === galpaoNome;
    if (decisao === "transferencia") return p.filialOrigem !== galpaoNome;
    return false;
  });
}

/**
 * Filters auto-approved orders by galpão name.
 * When galpaoNome is null, returns all (admin/all view).
 */
export function filtrarAutoGalpao(pedidos: Pedido[], galpaoNome: string | null): Pedido[] {
  if (!galpaoNome) return pedidos;
  return pedidos.filter((p) => p.filialOrigem === galpaoNome);
}

// ─── Legacy: Cargo-based filtering (kept for backward compat) ───────────────

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
 * @deprecated Use filtrarPendentesGalpao instead
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
      if (!galpao) {
        filtered = pedidos;
      } else {
        filtered = pedidos.filter((p) => {
          const sugestao = p.sugestao;
          if (sugestao === "transferencia") return p.filialOrigem !== galpao;
          return p.filialOrigem === galpao;
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
 * @deprecated Use filtrarConcluidosGalpao instead
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
 * @deprecated Use filtrarAutoGalpao instead
 */
export function filtrarAuto(pedidos: Pedido[], cargos: Cargo | Cargo[]): Pedido[] {
  const roles = normalizeCargos(cargos);
  if (roles.includes("admin")) return pedidos;

  const ids = new Set<string>();
  const result: Pedido[] = [];

  for (const cargo of roles) {
    if (cargo === "comprador") continue;
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

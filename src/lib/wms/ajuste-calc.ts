/**
 * Núcleo puro do Modelo A "editar a realidade" do modal de ajuste de estoque.
 *
 * Dado o saldo atual de cada localização (`linhas`), o valor real digitado por
 * loc (`drafts` — ausente ou vazio = não alterado) e as linhas de loc nova,
 * deriva a lista de ajustes (entrada/saída) a postar em `/api/wms/ajuste`.
 * Sem efeito colateral — testável isolado, sem deps de React.
 */

export interface AjusteLinhaCalc {
  localizacao_id: string;
  direcao: "entrada" | "saida";
  qty: number;
  custo_unitario?: number;
}

export interface CalcLinha {
  localizacao_id: string;
  saldo: number;
  reservado: number;
}

export interface CalcNova {
  localizacao_id: string;
  qty: string;
  custo?: string;
}

export interface CalcResultado {
  ajustes: AjusteLinhaCalc[];
  /** Alguma loc existente teria saldo real < reservado (viola CHECK). */
  erroReserva: boolean;
  /** Alguma loc nova repete uma loc da lista / outra loc nova. */
  erroDuplicada: boolean;
}

export function calcularAjustes(
  linhas: CalcLinha[],
  drafts: Record<string, string>,
  novas: CalcNova[],
): CalcResultado {
  const ajustes: AjusteLinhaCalc[] = [];
  let erroReserva = false;

  for (const l of linhas) {
    const raw = drafts[l.localizacao_id];
    if (raw === undefined || raw.trim() === "") continue; // não alterado
    const real = Number(raw);
    if (!Number.isFinite(real) || real < 0) continue;
    if (real < l.reservado) {
      erroReserva = true;
      continue;
    }
    const delta = real - l.saldo;
    if (delta === 0) continue;
    ajustes.push({
      localizacao_id: l.localizacao_id,
      direcao: delta > 0 ? "entrada" : "saida",
      qty: Math.abs(delta),
    });
  }

  let erroDuplicada = false;
  const idsExistentes = new Set(linhas.map((l) => l.localizacao_id));
  const vistos = new Set<string>();
  for (const n of novas) {
    if (!n.localizacao_id) continue;
    const q = Number(n.qty);
    if (!Number.isFinite(q) || q <= 0) continue;
    if (idsExistentes.has(n.localizacao_id) || vistos.has(n.localizacao_id)) {
      erroDuplicada = true;
      continue;
    }
    vistos.add(n.localizacao_id);
    const custo =
      n.custo != null && n.custo.trim() !== "" ? Number(n.custo) : undefined;
    ajustes.push({
      localizacao_id: n.localizacao_id,
      direcao: "entrada",
      qty: q,
      ...(custo != null && Number.isFinite(custo) && custo >= 0
        ? { custo_unitario: custo }
        : {}),
    });
  }

  return { ajustes, erroReserva, erroDuplicada };
}

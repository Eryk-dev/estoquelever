/**
 * Filtro de prazo de envio por DIA específico (multi-select).
 *
 * `siso_pedidos.prazo_envio` é timestamptz UTC; o "dia" do prazo é o dia no
 * fuso America/Sao_Paulo (mesma noção usada no encaixotamento). O Brasil não
 * tem mais horário de verão desde 2019, então SP é fixo em -03:00 — daí o
 * boundary do dia poder ser calculado direto, sem lib de timezone.
 *
 * Funções puras (testáveis, sem I/O): a rota consome `construirOrPrazoDias`
 * pra montar o filtro PostgREST e `agruparPedidosPorDiaSp` pra o facet de dias
 * disponíveis no multi-select.
 */

/** Offset fixo de America/Sao_Paulo (sem DST desde 2019). */
const SP_OFFSET = "-03:00";

/** Token que representa "Sem prazo" (prazo_envio IS NULL) na lista de dias. */
export const PRAZO_DIA_SEM = "sem";

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "YYYY-MM-DD" (dia em SP) → range UTC [de, ate) cobrindo o dia inteiro em SP.
 * Ex.: "2026-06-25" → { de: 2026-06-25T03:00:00Z, ate: 2026-06-26T03:00:00Z }.
 */
export function diaSpParaRangeUtc(dia: string): { de: string; ate: string } {
  const de = new Date(`${dia}T00:00:00${SP_OFFSET}`);
  const ate = new Date(de.getTime() + 24 * 60 * 60 * 1000);
  return { de: de.toISOString(), ate: ate.toISOString() };
}

/** O dia (SP) de um prazo_envio, ou PRAZO_DIA_SEM se null. */
export function diaSpDePrazo(prazoEnvio: string | null | undefined): string {
  if (!prazoEnvio) return PRAZO_DIA_SEM;
  return new Date(prazoEnvio).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * Agrupa pedidos pelo DIA de prazo (SP), com contagem. null → bucket
 * PRAZO_DIA_SEM. Ordenado por dia asc, com "sem prazo" sempre por último.
 */
export function agruparPedidosPorDiaSp(
  pedidos: { prazo_envio: string | null }[],
): { dia: string; count: number }[] {
  const map = new Map<string, number>();
  for (const p of pedidos) {
    const dia = diaSpDePrazo(p.prazo_envio);
    map.set(dia, (map.get(dia) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([dia, count]) => ({ dia, count }))
    .sort((a, b) => {
      if (a.dia === PRAZO_DIA_SEM) return 1;
      if (b.dia === PRAZO_DIA_SEM) return -1;
      return a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0;
    });
}

/**
 * Monta o filtro `.or(...)` do PostgREST pra uma lista de dias (SP) selecionados.
 * Cada dia vira um range [de,ate); o token "sem" vira prazo_envio.is.null.
 * Dias malformados são ignorados. Retorna null se nada sobrar (= sem filtro).
 */
export function construirOrPrazoDias(dias: string[]): string | null {
  const limpos = dias.map((d) => d.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const dia of limpos) {
    if (dia === PRAZO_DIA_SEM) {
      parts.push("prazo_envio.is.null");
      continue;
    }
    if (!DIA_RE.test(dia)) continue;
    if (isNaN(new Date(`${dia}T00:00:00${SP_OFFSET}`).getTime())) continue;
    const { de, ate } = diaSpParaRangeUtc(dia);
    parts.push(`and(prazo_envio.gte.${de},prazo_envio.lt.${ate})`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

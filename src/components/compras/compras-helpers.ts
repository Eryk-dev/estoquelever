export function agingColor(dias: number): string {
  if (dias < 1) return "border-l-emerald-400";
  if (dias <= 2) return "border-l-amber-400";
  return "border-l-red-400";
}

export function agingBadgeClass(dias: number): string {
  if (dias < 1) return "bg-emerald-50 text-emerald-700";
  if (dias <= 2) return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-red-700";
}

export function formatAging(dias: number): string {
  if (dias <= 0) return "hoje";
  if (dias === 1) return "há 1d";
  return `há ${dias}d`;
}

export function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

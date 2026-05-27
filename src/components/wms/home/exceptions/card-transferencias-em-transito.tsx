"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { TransferenciaTransitoCard } from "@/lib/wms/dashboard-tarefas";

function idadeHoras(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
}

function badgeTempo(iso: string): { label: string; tone: "ok" | "warn" | "alert" } {
  const h = idadeHoras(iso);
  if (h < 24) return { label: `${h}h`, tone: "ok" };
  const d = Math.floor(h / 24);
  if (h < 72) return { label: `${d}d`, tone: "warn" };
  return { label: `${d}d`, tone: "alert" };
}

interface Props {
  count: number;
  itens: TransferenciaTransitoCard[];
}

export function CardTransferenciasEmTransito({ count, itens }: Props) {
  return (
    <Link
      href="/wms/transferir"
      className="wms-excecao-card"
      aria-label={`Transferências em trânsito: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="truck" size={14} />
        <span className="wms-excecao-card-titulo">
          Transferências em trânsito
        </span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-info"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">
          Nada em trânsito.
        </div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((t) => {
            const b = badgeTempo(t.criada_em);
            return (
              <div key={t.id} className="wms-excecao-card-linha">
                <span>
                  {t.origem_galpao_nome ?? "—"} → {t.destino_galpao_nome ?? "—"}
                </span>
                <span className="wms-td-mute">{t.qty_itens} itens</span>
                <span className={`wms-excecao-badge wms-excecao-badge-${b.tone}`}>
                  {b.label}
                </span>
              </div>
            );
          })}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} transferências</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

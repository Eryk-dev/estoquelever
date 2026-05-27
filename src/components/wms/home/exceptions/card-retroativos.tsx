"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { RetroativoPendenteCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: RetroativoPendenteCard[];
}

export function CardRetroativos({ count, itens }: Props) {
  return (
    <Link
      href="/wms/retroativos"
      className="wms-excecao-card"
      aria-label={`Retroativos pendentes: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="history" size={14} />
        <span className="wms-excecao-card-titulo">
          Retroativos pendentes
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
        <div className="wms-excecao-card-vazio">Nenhum lançamento aberto.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((r) => (
            <div key={r.id} className="wms-excecao-card-linha">
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-mono">{r.qty}</span>
              <span className="wms-td-mute" title={r.motivo}>
                {r.motivo.length > 30
                  ? r.motivo.slice(0, 30) + "…"
                  : r.motivo}
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">
              +{count - 3} lançamentos
            </div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

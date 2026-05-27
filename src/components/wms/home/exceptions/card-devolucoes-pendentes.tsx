"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { DevolucaoPendenteCard } from "@/lib/wms/dashboard-tarefas";

function formatarTempo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

interface Props {
  count: number;
  itens: DevolucaoPendenteCard[];
}

export function CardDevolucoesPendentes({ count, itens }: Props) {
  return (
    <Link
      href="/wms/devolucoes"
      className="wms-excecao-card"
      aria-label={`Devoluções pendentes: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="box" size={14} />
        <span className="wms-excecao-card-titulo">Devoluções pendentes</span>
        <span
          className={
            count > 0
              ? "wms-excecao-card-count wms-excecao-card-count-warn"
              : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">
          Nada na fila — bom trabalho.
        </div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((d) => (
            <div key={d.id} className="wms-excecao-card-linha">
              <span className="wms-mono">
                NF {d.nota_fiscal_id ?? "—"}
              </span>
              <span className="wms-td-mute">
                {d.empresa_referencia_nome ?? "—"}
              </span>
              <span className="wms-td-mute">
                {formatarTempo(d.criada_em)}
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">
              +{count - 3} pendência{count - 3 === 1 ? "" : "s"}
            </div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

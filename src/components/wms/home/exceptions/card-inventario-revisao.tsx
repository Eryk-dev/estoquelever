"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { InventarioRevisaoCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: InventarioRevisaoCard[];
}

export function CardInventarioRevisao({ count, itens }: Props) {
  return (
    <Link
      href="/wms/inventario"
      className="wms-excecao-card"
      aria-label={`Inventário em revisão: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="clipboard" size={14} />
        <span className="wms-excecao-card-titulo">
          Inventário em revisão
        </span>
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
        <div className="wms-excecao-card-vazio">Nenhum em revisão.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((s) => (
            <div key={s.id} className="wms-excecao-card-linha">
              <span>{s.nome}</span>
              {s.galpao_nome ? (
                <span className="wms-td-mute">{s.galpao_nome}</span>
              ) : null}
              <span
                className={
                  s.total_divergencias > 0
                    ? "wms-excecao-badge wms-excecao-badge-warn"
                    : "wms-excecao-badge wms-excecao-badge-ok"
                }
              >
                {s.total_divergencias} div.
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} sessões</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

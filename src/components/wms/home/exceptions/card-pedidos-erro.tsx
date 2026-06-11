"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { PedidoErroCard } from "@/lib/wms/dashboard-tarefas";

const LIMITE_ALERTA = 3;

interface Props {
  count: number;
  itens: PedidoErroCard[];
}

export function CardPedidosErro({ count, itens }: Props) {
  const isAlerta = count > LIMITE_ALERTA;
  return (
    <Link
      href="/wms/pedidos"
      className="wms-excecao-card"
      aria-label={`Pedidos em erro: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="alert" size={14} />
        <span className="wms-excecao-card-titulo">
          Pedidos em erro (job esgotado)
        </span>
        <span
          className={
            isAlerta
              ? "wms-excecao-card-count wms-excecao-card-count-alert"
              : count > 0
                ? "wms-excecao-card-count wms-excecao-card-count-warn"
                : "wms-excecao-card-count"
          }
        >
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">Sem pedidos em erro.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {isAlerta ? (
            <div className="wms-excecao-card-alerta">
              Acima de {LIMITE_ALERTA} — investigar fila de execução.
            </div>
          ) : null}
          {itens.slice(0, 3).map((p) => (
            <div key={p.pedido_id} className="wms-excecao-card-linha">
              <span className="wms-mono">{p.pedido_id.slice(0, 10)}</span>
              <span className="wms-td-mute">
                {p.origem === "job" ? "job" : "pedido"}
              </span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} pedidos</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

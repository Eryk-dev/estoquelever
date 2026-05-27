"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { ReservaOrfaCard } from "@/lib/wms/dashboard-tarefas";

const LIMITE_ALERTA = 5;

interface Props {
  count: number;
  itens: ReservaOrfaCard[];
}

export function CardReservasOrfas({ count, itens }: Props) {
  const isAlerta = count > LIMITE_ALERTA;
  return (
    <Link
      href="/wms/ledger?tipo=R&orfas=true"
      className="wms-excecao-card"
      aria-label={`Reservas órfãs: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="alert" size={14} />
        <span className="wms-excecao-card-titulo">
          Reservas órfãs (pedidos cancelados)
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
        <div className="wms-excecao-card-vazio">Sem Rs órfãs.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {isAlerta ? (
            <div className="wms-excecao-card-alerta">
              Acima de {LIMITE_ALERTA} — investigar webhook cancelamento.
            </div>
          ) : null}
          {itens.slice(0, 3).map((r) => (
            <div key={r.id} className="wms-excecao-card-linha">
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-td-mute">
                pedido {r.pedido_numero ?? r.pedido_id?.slice(0, 6)}
              </span>
              <span className="wms-mono">{r.qty}</span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} Rs</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

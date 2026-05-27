"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { RecebimentoOrfaoCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: RecebimentoOrfaoCard[];
}

export function CardRecebimentoOrfao({ count, itens }: Props) {
  return (
    <Link
      href="/wms/estoque?perspectiva=localizacao&tipo=recebimento"
      className="wms-excecao-card"
      aria-label={`Saldo órfão em RECEBIMENTO: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="box" size={14} />
        <span className="wms-excecao-card-titulo">
          Saldo órfão em RECEBIMENTO
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
        <div className="wms-excecao-card-vazio">Dock limpo.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((r) => (
            <div
              key={`${r.produto_id}::${r.galpao_id}`}
              className="wms-excecao-card-linha"
            >
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-td-mute">
                {r.galpao_nome ?? "—"} · {r.localizacao_codigo}
              </span>
              <span className="wms-mono">{r.saldo}</span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} posições</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

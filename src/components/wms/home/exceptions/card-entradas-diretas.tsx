"use client";

import Link from "next/link";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { EntradaDiretaCard } from "@/lib/wms/dashboard-tarefas";

interface Props {
  count: number;
  itens: EntradaDiretaCard[];
}

/**
 * Card: entradas diretas hoje.
 *
 * Conta movs `nf_compra` cuja loc destino NÃO é tipo='recebimento' — ou seja,
 * recebimentos que pularam o dock RECEBIMENTO (flag `entrada_direta=true`).
 * Não é exceção destrutiva (saldo entrou correto no ledger), só visibilidade
 * pra supervisor monitorar quantas entradas escapam o fluxo padrão de guarda.
 */
export function CardEntradasDiretas({ count, itens }: Props) {
  return (
    <Link
      href="/wms/ledger?origem_tipo=nf_compra"
      className="wms-excecao-card"
      aria-label={`Entradas diretas hoje: ${count}`}
    >
      <div className="wms-excecao-card-head">
        <Icon name="box" size={14} />
        <span className="wms-excecao-card-titulo">Entradas diretas hoje</span>
        <span className="wms-excecao-card-count">{count}</span>
      </div>
      {count === 0 ? (
        <div className="wms-excecao-card-vazio">Nenhuma hoje.</div>
      ) : (
        <div className="wms-excecao-card-lista">
          {itens.slice(0, 3).map((r) => (
            <div key={r.mov_id} className="wms-excecao-card-linha">
              <span className="wms-mono">{r.produto_sku}</span>
              <span className="wms-td-mute">
                {r.galpao_nome ?? "—"} · {r.localizacao_codigo}
              </span>
              <span className="wms-mono">+{r.qty}</span>
            </div>
          ))}
          {count > 3 ? (
            <div className="wms-excecao-card-mais">+{count - 3} outras</div>
          ) : null}
        </div>
      )}
    </Link>
  );
}

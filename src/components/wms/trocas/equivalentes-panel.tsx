"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { Icon, fmtNum } from "@/components/wms/ui/wms-ui";
import {
  TIER_LABEL,
  type TierQualidade,
  type ParVerificacao,
} from "@/lib/wms/trocas-equivalencia-regra";

// Item devolvido por GET /api/wms/trocas/equivalentes.
interface Equivalente {
  produto_id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  tier_qualidade: TierQualidade | null;
  par_verificacao: ParVerificacao;
  disponivel_galpao: number;
}

/**
 * Painel compartilhado de troca por equivalência (separação + compras + painel).
 * Lista os equivalentes do cluster cross com saldo no galpão e permite solicitar
 * a troca (POST /api/wms/trocas). auto=true aplica na hora; auto=false fica
 * aguardando aprovação.
 */
export function EquivalentesPanel({
  sku,
  galpaoId,
  pedidoItemId,
  origem,
  onTrocaCriada,
}: {
  sku: string;
  galpaoId: string;
  pedidoItemId: number | string;
  origem: "separacao" | "compras";
  onTrocaCriada?: (resultado: { auto: boolean }) => void;
}) {
  const [enviando, setEnviando] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["wms-trocas-equivalentes", sku, galpaoId],
    queryFn: async () => {
      const r = await sisoFetch(
        `/api/wms/trocas/equivalentes?sku=${encodeURIComponent(sku)}&galpao_id=${encodeURIComponent(galpaoId)}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ sku: string; equivalentes: Equivalente[] }>;
    },
    enabled: !!sku && !!galpaoId,
  });

  // Só mostra os que têm saldo no galpão (o backend inclui disponivel=0).
  const comSaldo = useMemo(
    () => (data?.equivalentes ?? []).filter((e) => e.disponivel_galpao > 0),
    [data?.equivalentes],
  );

  async function solicitar(e: Equivalente) {
    setEnviando(e.sku);
    try {
      const r = await sisoFetch("/api/wms/trocas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_item_id: pedidoItemId,
          sku_substituto: e.sku,
          origem,
        }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        auto?: boolean;
        error?: string;
      };
      if (!r.ok) {
        toast.error(body.error ?? "Erro ao solicitar troca");
        return;
      }
      if (body.auto) {
        toast.success(`Troca aplicada — separe o SKU ${e.sku}`);
      } else {
        toast.info("Troca enviada pra aprovação");
      }
      onTrocaCriada?.({ auto: !!body.auto });
    } catch {
      toast.error("Erro de conexão ao solicitar troca");
    } finally {
      setEnviando(null);
    }
  }

  if (isLoading) {
    return (
      <div className="wms-td-mute" style={{ fontSize: 12, padding: "8px 0" }}>
        Buscando equivalentes…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="wms-td-mute" style={{ fontSize: 12, padding: "8px 0" }}>
        Erro ao buscar equivalentes.
      </div>
    );
  }

  if (comSaldo.length === 0) {
    return (
      <div className="wms-td-mute" style={{ fontSize: 12, padding: "8px 0" }}>
        Nenhum equivalente com estoque neste galpão.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {comSaldo.map((e) => {
        const verificado = e.par_verificacao === "verificado";
        return (
          <div
            key={e.produto_id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 8px",
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-3)",
              background: "var(--wms-c-faint)",
            }}
          >
            {e.imagem_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={e.imagem_url}
                alt={e.sku}
                className="wms-thumb wms-thumb-xs"
                loading="lazy"
              />
            ) : (
              <div
                className="wms-thumb wms-thumb-xs"
                style={{
                  display: "grid",
                  placeItems: "center",
                  background: "var(--wms-c-panel-2)",
                }}
              >
                <Icon name="box" size={12} className="wms-td-mute" />
              </div>
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="wms-mono"
                  style={{ fontWeight: 600, fontSize: 12.5 }}
                >
                  {e.sku}
                </span>
                <span
                  className={`wms-badge ${e.tier_qualidade ? "wms-badge-info" : "wms-badge-mute"}`}
                  style={{ fontSize: 10 }}
                >
                  {e.tier_qualidade
                    ? TIER_LABEL[e.tier_qualidade]
                    : "Sem classificação"}
                </span>
                <span
                  className={`wms-badge ${verificado ? "wms-badge-ok" : "wms-badge-mute"}`}
                  style={{ fontSize: 10 }}
                  title={
                    verificado
                      ? "Par verificado por humano — troca livre se mesmo nível"
                      : "Par não verificado — troca exige aprovação"
                  }
                >
                  {verificado ? "✓ Verificado" : "Não verificado"}
                </span>
              </div>
              <div
                className="wms-td-mute"
                style={{
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.descricao}
              </div>
            </div>
            <div
              className="wms-mono wms-tar"
              style={{ fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" }}
              title="Disponível neste galpão"
            >
              {fmtNum(e.disponivel_galpao)}
            </div>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-primary"
              disabled={enviando !== null}
              onClick={() => solicitar(e)}
              style={{ whiteSpace: "nowrap" }}
            >
              {enviando === e.sku ? "Enviando…" : "Usar equivalente"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

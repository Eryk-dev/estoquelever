"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { Icon, PageHeader, Field } from "@/components/wms/ui/wms-ui";

interface Quadrupla {
  produto_id?: string;
  empresa_id?: string;
  galpao_id?: string;
  localizacao_id?: string;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function TrocaSkuPage() {
  const queryClient = useQueryClient();
  const [pedidoId, setPedidoId] = useState("");
  const [original, setOriginal] = useState<Quadrupla & { sku?: string }>({});
  const [substituto, setSubstituto] = useState<Quadrupla & { sku?: string }>(
    {},
  );
  const [qty, setQty] = useState(1);
  const [motivo, setMotivo] = useState("");

  async function buscarOriginal(s: string) {
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (r.rows?.[0]) {
        setOriginal((prev) => ({
          ...prev,
          produto_id: r.rows![0].id,
          sku: r.rows![0].sku,
        }));
      } else toast.error("SKU não encontrado");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function buscarSubstituto(s: string) {
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (r.rows?.[0]) {
        setSubstituto((prev) => ({
          ...prev,
          produto_id: r.rows![0].id,
          sku: r.rows![0].sku,
        }));
      } else toast.error("SKU não encontrado");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/troca-sku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_id: pedidoId,
          qty,
          motivo,
          quadrupla_original: {
            produto_id: original.produto_id,
            empresa_dona_id: original.empresa_id,
            galpao_id: original.galpao_id,
            localizacao_id: original.localizacao_id,
          },
          quadrupla_substituto: {
            produto_id: substituto.produto_id,
            empresa_dona_id: substituto.empresa_id,
            galpao_id: substituto.galpao_id,
            localizacao_id: substituto.localizacao_id,
          },
        }),
      }),
    onSuccess: () => {
      toast.success("Troca registrada");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid =
    !!pedidoId &&
    !!original.produto_id &&
    !!substituto.produto_id &&
    !!original.localizacao_id &&
    !!substituto.localizacao_id &&
    qty > 0;

  return (
    <>
      <PageHeader
        title="Troca de SKU na separação"
        subtitle="Estorna reserva do SKU original e cria reserva no substituto (par L+R com mesma origem_id)"
      />

      <Field label="Pedido" required>
        <input
          className="wms-input wms-mono"
          value={pedidoId}
          onChange={(e) => setPedidoId(e.target.value)}
          placeholder="ID do pedido SISO"
        />
      </Field>

      <div className="wms-trans-grid">
        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill">SKU original</span>{" "}
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              estorna reserva
            </span>
          </div>
          <Field label="SKU" required>
            <input
              className="wms-input wms-mono"
              placeholder="bipe ou digite — Enter resolve"
              defaultValue={original.sku ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) buscarOriginal(v);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !original.produto_id) buscarOriginal(v);
              }}
            />
          </Field>
          <Field label="Empresa + localização">
            <QuadruplaPicker
              value={original}
              onChange={(v) =>
                setOriginal((prev) => ({
                  ...prev,
                  empresa_id: v.empresa_id,
                  galpao_id: v.galpao_id,
                  localizacao_id: v.localizacao_id,
                }))
              }
            />
          </Field>
        </div>

        <div className="wms-trans-arrow">
          <Icon name="arrow-right" size={20} />
          <span className="wms-td-mute" style={{ fontSize: 11 }}>
            par L+R
          </span>
        </div>

        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill wms-trans-pill-dest">
              SKU substituto
            </span>{" "}
            <span className="wms-td-mute" style={{ fontSize: 11 }}>
              cria reserva
            </span>
          </div>
          <Field label="SKU" required>
            <input
              className="wms-input wms-mono"
              placeholder="bipe ou digite — Enter resolve"
              defaultValue={substituto.sku ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) buscarSubstituto(v);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !substituto.produto_id) buscarSubstituto(v);
              }}
            />
          </Field>
          <Field label="Empresa + localização">
            <QuadruplaPicker
              value={substituto}
              onChange={(v) =>
                setSubstituto((prev) => ({
                  ...prev,
                  empresa_id: v.empresa_id,
                  galpao_id: v.galpao_id,
                  localizacao_id: v.localizacao_id,
                }))
              }
            />
          </Field>
        </div>
      </div>

      <div className="wms-row-2" style={{ marginTop: 20 }}>
        <Field label="Quantidade" required>
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </Field>
        <Field label="Motivo">
          <input
            className="wms-input"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="motivo da troca"
          />
        </Field>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          paddingTop: 16,
          borderTop: "1px solid var(--wms-c-border)",
        }}
      >
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={!valid || submit.isPending}
          onClick={() => submit.mutate()}
        >
          <Icon name="edit" size={11} />
          {submit.isPending ? "Trocando…" : "Trocar SKU"}
        </button>
      </div>
    </>
  );
}

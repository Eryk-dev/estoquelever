"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { Icon, PageHeader, Field } from "@/components/wms/ui/wms-ui";

interface Item {
  produto_id?: string;
  sku?: string;
  qty: number;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function TransferirPage() {
  const queryClient = useQueryClient();
  const [empresa_id, setEmpresa] = useState<string | undefined>();
  const [origem, setOrigem] = useState<{
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [destino, setDestino] = useState<{
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverSku(s: string, idx: number) {
    try {
      const json = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (!json.rows?.[0]) {
        toast.error("SKU não encontrado");
        return;
      }
      const p = json.rows[0];
      setItens((prev) =>
        prev.map((x, i) =>
          i === idx ? { ...x, produto_id: p.id, sku: p.sku } : x,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/transferir-galpao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id,
          galpao_origem_id: origem.galpao_id,
          localizacao_origem_id: origem.localizacao_id,
          galpao_destino_id: destino.galpao_id,
          localizacao_destino_id: destino.localizacao_id,
          itens: itens.map((i) => ({ produto_id: i.produto_id, qty: i.qty })),
        }),
      }),
    onSuccess: () => {
      toast.success("Transferência registrada");
      setItens([]);
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mesmaLocalizacao =
    !!origem.localizacao_id &&
    !!destino.localizacao_id &&
    origem.localizacao_id === destino.localizacao_id;

  const valid =
    !!empresa_id &&
    !!origem.localizacao_id &&
    !!destino.localizacao_id &&
    !mesmaLocalizacao &&
    itens.length > 0 &&
    itens.every((i) => i.produto_id && i.qty > 0);

  return (
    <>
      <PageHeader
        title="Transferências entre galpões"
        subtitle="Movimentação par S+E entre CDs/filiais — mesma origem_id"
      />

      <div className="wms-trans-grid">
        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill">Origem</span>
          </div>
          <Field label="Empresa + localização" required>
            <QuadruplaPicker
              value={{ empresa_id, ...origem }}
              onChange={(v) => {
                setEmpresa(v.empresa_id);
                setOrigem({
                  galpao_id: v.galpao_id,
                  localizacao_id: v.localizacao_id,
                });
              }}
            />
          </Field>
        </div>

        <div className="wms-trans-arrow">
          <Icon name="arrow-right" size={20} />
          <span className="wms-td-mute" style={{ fontSize: 11 }}>
            par S+E
          </span>
        </div>

        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill wms-trans-pill-dest">Destino</span>
          </div>
          <Field label="Empresa + localização" required>
            <QuadruplaPicker
              value={{ empresa_id, ...destino }}
              onChange={(v) => {
                setEmpresa(v.empresa_id);
                setDestino({
                  galpao_id: v.galpao_id,
                  localizacao_id: v.localizacao_id,
                });
              }}
            />
          </Field>
        </div>
      </div>

      {mesmaLocalizacao && (
        <div className="wms-hint-card wms-hint-danger" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <span>
            <strong>Origem e destino iguais.</strong> Use{" "}
            <a href="/wms/replenishment" className="wms-link-row">
              Replenishment
            </a>{" "}
            para mover entre localizações no mesmo galpão.
          </span>
        </div>
      )}

      <h3 className="wms-sec-h" style={{ marginTop: 20 }}>
        Itens
      </h3>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginBottom: 16,
        }}
      >
        {itens.map((it, idx) => (
          <div
            key={idx}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--wms-c-panel)",
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-2)",
              padding: 10,
            }}
          >
            <input
              className="wms-input wms-mono"
              placeholder="SKU"
              defaultValue={it.sku ?? ""}
              style={{ flex: 1, minWidth: 0 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v && !it.produto_id) resolverSku(v, idx);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !it.produto_id) resolverSku(v, idx);
              }}
            />
            <input
              className="wms-input wms-mono wms-tar"
              type="number"
              min={1}
              value={it.qty}
              style={{ width: 80 }}
              onChange={(e) =>
                setItens((p) =>
                  p.map((x, i) =>
                    i === idx ? { ...x, qty: Number(e.target.value) } : x,
                  ),
                )
              }
            />
            <button
              type="button"
              className="wms-btn-icon"
              title="Remover"
              onClick={() => setItens((p) => p.filter((_, i) => i !== idx))}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          style={{ borderStyle: "dashed", alignSelf: "flex-start" }}
          onClick={() => setItens((p) => [...p, { qty: 1 }])}
        >
          <Icon name="plus" size={11} />
          Adicionar item
        </button>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={!valid || submit.isPending}
          onClick={() => submit.mutate()}
        >
          <Icon name="arrow-right" size={11} />
          {submit.isPending ? "Salvando…" : "Registrar transferência"}
        </button>
      </div>
    </>
  );
}

"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { QuadruplaPicker } from "@/components/wms/quadrupla-picker";
import { Icon, PageHeader, Field } from "@/components/wms/ui/wms-ui";

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function AjustePage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState<{
    empresa_id?: string;
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [produto_id, setProduto] = useState<string | undefined>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [motivo, setMotivo] = useState("");

  async function buscar(s: string) {
    try {
      const r = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(s)}&limit=1`,
      );
      if (r.rows?.[0]) {
        setProduto(r.rows[0].id);
        setSku(r.rows[0].sku);
      } else {
        toast.error("SKU não encontrado");
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>("/api/wms/ajuste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quadrupla: { produto_id, ...q },
          qty,
          direcao,
          motivo,
        }),
      }),
    onSuccess: () => {
      toast.success("Ajuste registrado");
      setQty(1);
      setMotivo("");
      setProduto(undefined);
      setSku("");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const motivoTooShort = motivo.length > 0 && motivo.length < 3;
  const valid =
    !!produto_id &&
    !!q.localizacao_id &&
    motivo.length >= 3 &&
    qty > 0;

  return (
    <>
      <PageHeader
        title="Ajuste manual"
        subtitle="Entrada ou saída pontual com motivo registrado no ledger"
      />

      <h3 className="wms-sec-h">Localização do ajuste</h3>
      <div style={{ marginBottom: 16 }}>
        <QuadruplaPicker value={q} onChange={setQ} />
      </div>

      <Field label="Produto" required>
        <input
          className="wms-input wms-mono"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) buscar(v);
            }
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v) buscar(v);
          }}
          placeholder="SKU ou GTIN — Enter para resolver"
        />
      </Field>

      <div className="wms-row-2">
        <Field label="Direção" required>
          <div className="wms-seg wms-seg-full">
            <button
              type="button"
              className={`wms-seg-btn ${direcao === "entrada" ? "is-active" : ""}`}
              onClick={() => setDirecao("entrada")}
            >
              + Entrada
            </button>
            <button
              type="button"
              className={`wms-seg-btn ${direcao === "saida" ? "is-active" : ""}`}
              onClick={() => setDirecao("saida")}
            >
              − Saída
            </button>
          </div>
        </Field>
        <Field label="Quantidade" required>
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </Field>
      </div>

      <Field
        label="Motivo"
        required
        hint={motivoTooShort ? "muito curto" : "mín. 3 caracteres"}
      >
        <textarea
          className="wms-textarea"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="avaria, perda, encontro, erro de contagem…"
          rows={3}
        />
      </Field>

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
          <Icon name="sliders" size={11} />
          {submit.isPending ? "Salvando…" : "Registrar ajuste"}
        </button>
      </div>
    </>
  );
}

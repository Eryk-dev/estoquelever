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
  custo_unitario?: number;
  localizacao_id?: string;
  localizacao_codigo?: string;
  putawayRazao?: string;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

interface PutawaySugestao {
  localizacao_id: string;
  codigo?: string;
  razao: string;
}

export default function ReceberPage() {
  const queryClient = useQueryClient();
  const [base, setBase] = useState<{ empresa_id?: string; galpao_id?: string }>(
    {},
  );
  const [nf, setNf] = useState("");
  const [itens, setItens] = useState<Item[]>([]);

  async function resolverProdutoESugestao(skuOuGtin: string, idx: number) {
    if (!base.empresa_id || !base.galpao_id) {
      toast.error("Escolha empresa e galpão antes");
      return;
    }
    try {
      const json = await wmsApi<{ rows?: ProdutoMin[] }>(
        `/api/wms/produtos?q=${encodeURIComponent(skuOuGtin)}&limit=1`,
      );
      const p = json.rows?.[0];
      if (!p) {
        toast.error(`SKU não encontrado: ${skuOuGtin}`);
        return;
      }
      const sug = await wmsApi<PutawaySugestao>(
        `/api/wms/receber?produto_id=${p.id}&empresa_id=${base.empresa_id}&galpao_id=${base.galpao_id}`,
      );
      setItens((prev) =>
        prev.map((it, i) =>
          i === idx
            ? {
                ...it,
                produto_id: p.id,
                sku: p.sku,
                localizacao_id: sug.localizacao_id,
                localizacao_codigo: sug.codigo,
                putawayRazao: sug.razao,
              }
            : it,
        ),
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const submit = useMutation({
    mutationFn: () => {
      const naoResolvidos = itens.filter(
        (i) => !i.produto_id || !i.localizacao_id,
      );
      if (naoResolvidos.length > 0) {
        throw new Error(
          `${naoResolvidos.length} item(ns) sem SKU/localização resolvidos`,
        );
      }
      return wmsApi<{ ok: true }>("/api/wms/receber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_dona_id: base.empresa_id,
          galpao_id: base.galpao_id,
          nf_referencia: nf || undefined,
          itens: itens.map((i) => ({
            produto_id: i.produto_id,
            qty: i.qty,
            custo_unitario: i.custo_unitario,
            localizacao_id: i.localizacao_id,
          })),
        }),
      });
    },
    onSuccess: () => {
      toast.success("Estoque recebido");
      setItens([]);
      setNf("");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
      queryClient.invalidateQueries({ queryKey: ["wms-cobertura"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid =
    !!base.empresa_id &&
    !!base.galpao_id &&
    itens.length > 0 &&
    itens.every((i) => i.produto_id && i.localizacao_id && i.qty > 0);

  return (
    <>
      <PageHeader
        title="Receber mercadoria"
        subtitle="Entrada de estoque com sugestão automática de putaway"
      />

      <h3 className="wms-sec-h">Empresa & galpão</h3>
      <div style={{ marginBottom: 12 }}>
        <QuadruplaPicker
          value={base}
          onChange={(v) =>
            setBase({ empresa_id: v.empresa_id, galpao_id: v.galpao_id })
          }
          showLocalizacao={false}
        />
      </div>

      <Field label="NF de referência" hint="opcional">
        <input
          className="wms-input"
          value={nf}
          onChange={(e) => setNf(e.target.value)}
          placeholder="ex.: NF-7821"
        />
      </Field>

      <h3 className="wms-sec-h">Itens (bipe SKU/GTIN)</h3>
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
              flexWrap: "wrap",
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
              placeholder="bipe SKU/GTIN — Enter resolve"
              defaultValue={it.sku ?? ""}
              style={{ flex: 1, minWidth: 200 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v && !it.produto_id) resolverProdutoESugestao(v, idx);
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !it.produto_id) resolverProdutoESugestao(v, idx);
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
            <input
              className="wms-input wms-mono wms-tar"
              type="number"
              step="0.01"
              placeholder="custo"
              value={it.custo_unitario ?? ""}
              style={{ width: 100 }}
              onChange={(e) =>
                setItens((p) =>
                  p.map((x, i) =>
                    i === idx
                      ? {
                          ...x,
                          custo_unitario: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        }
                      : x,
                  ),
                )
              }
            />
            {it.localizacao_codigo && (
              <span
                className="wms-td-mute"
                style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 4 }}
              >
                <Icon name="arrow-right" size={11} />
                <span className="wms-mono">{it.localizacao_codigo}</span>
                <span style={{ opacity: 0.8 }}>({it.putawayRazao})</span>
              </span>
            )}
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
          <Icon name="plus" size={11} />
          {submit.isPending ? "Salvando…" : "Registrar recebimento"}
        </button>
      </div>
    </>
  );
}

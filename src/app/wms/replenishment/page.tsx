"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
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

interface EmpresaRow {
  id: string;
  nome: string;
  galpao_id: string;
}

interface GalpaoRow {
  id: string;
  nome: string;
  empresas?: EmpresaRow[];
}

interface LocRow {
  id: string;
  codigo: string;
  tipo: string;
}

export default function ReplenishmentPage() {
  const queryClient = useQueryClient();
  const [empresa_id, setEmpresa] = useState<string | undefined>();
  const [galpao_id, setGalpao] = useState<string | undefined>();
  const [origem_loc, setOrigem] = useState<string | undefined>();
  const [destino_loc, setDestino] = useState<string | undefined>();
  const [itens, setItens] = useState<Item[]>([]);

  const { data: galpoesResp } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () => {
      const raw = await wmsApi<
        Array<{
          id: string;
          nome: string;
          siso_empresas?: Array<{ id: string; nome: string; ativo?: boolean }>;
        }>
      >("/api/admin/galpoes");
      return raw.map<GalpaoRow>((g) => ({
        id: g.id,
        nome: g.nome,
        empresas: (g.siso_empresas ?? [])
          .filter((e) => e.ativo !== false)
          .map((e) => ({ id: e.id, nome: e.nome, galpao_id: g.id })),
      }));
    },
  });

  const { data: locs } = useQuery({
    queryKey: ["wms-locs", galpao_id],
    queryFn: () =>
      wmsApi<{ rows: LocRow[] }>(`/api/wms/localizacoes?galpao_id=${galpao_id}`),
    enabled: !!galpao_id,
  });

  const empresas: EmpresaRow[] = (galpoesResp ?? []).flatMap((g) =>
    (g.empresas ?? []).map((e) => ({ ...e, galpao_id: g.id })),
  );

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
      wmsApi<{ ok: true }>("/api/wms/replenishment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id,
          galpao_id,
          localizacao_origem_id: origem_loc,
          localizacao_destino_id: destino_loc,
          itens: itens.map((i) => ({ produto_id: i.produto_id, qty: i.qty })),
        }),
      }),
    onSuccess: () => {
      toast.success("Replenishment registrado");
      setItens([]);
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid =
    !!empresa_id &&
    !!origem_loc &&
    !!destino_loc &&
    origem_loc !== destino_loc &&
    itens.length > 0 &&
    itens.every((i) => i.produto_id && i.qty > 0);

  return (
    <>
      <PageHeader
        title="Replenishment intra-galpão"
        subtitle="Mover entre localizações no mesmo galpão (overstock → picking)"
      />

      <div className="wms-trans-grid">
        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill">Empresa & origem</span>
          </div>
          <Field label="Empresa" required>
            <select
              className="wms-select"
              value={empresa_id ?? ""}
              onChange={(e) => {
                const sel = empresas.find((x) => x.id === e.target.value);
                setEmpresa(sel?.id);
                setGalpao(sel?.galpao_id);
                setOrigem(undefined);
                setDestino(undefined);
              }}
            >
              <option value="">— selecione —</option>
              {empresas.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Localização de origem" required>
            <select
              className="wms-select"
              value={origem_loc ?? ""}
              disabled={!galpao_id}
              onChange={(e) => setOrigem(e.target.value || undefined)}
            >
              <option value="">— selecione —</option>
              {locs?.rows
                ?.filter((l) => l.id !== destino_loc)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.codigo} ({l.tipo})
                  </option>
                ))}
            </select>
          </Field>
        </div>

        <div className="wms-trans-arrow">
          <Icon name="arrow-right" size={20} />
          <span className="wms-td-mute" style={{ fontSize: 11 }}>
            mesmo galpão
          </span>
        </div>

        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill wms-trans-pill-dest">Destino</span>
          </div>
          <Field label="Localização de destino" required>
            <select
              className="wms-select"
              value={destino_loc ?? ""}
              disabled={!galpao_id}
              onChange={(e) => setDestino(e.target.value || undefined)}
            >
              <option value="">— selecione —</option>
              {locs?.rows
                ?.filter((l) => l.id !== origem_loc)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.codigo} ({l.tipo})
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </div>

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
          <Icon name="shuffle" size={11} />
          {submit.isPending ? "Salvando…" : "Registrar replenishment"}
        </button>
      </div>
    </>
  );
}

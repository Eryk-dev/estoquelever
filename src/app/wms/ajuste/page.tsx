"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { usePermissoes } from "@/lib/auth-context";
import { TriplaPicker } from "@/components/wms/tripla-picker";
import { Icon, PageHeader, Field } from "@/components/wms/ui/wms-ui";

interface ProdutoMin {
  id: string;
  sku: string;
}

export default function AjustePage() {
  const queryClient = useQueryClient();
  const { can } = usePermissoes();
  const podeAjustar = can("operacoes.ajuste_manual");
  const [q, setQ] = useState<{
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [produto_id, setProduto] = useState<string | undefined>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [motivo, setMotivo] = useState("");
  const [motivoCategoria, setMotivoCategoria] = useState<
    | ""
    | "avaria"
    | "perda"
    | "achado"
    | "correcao_inventario"
    | "devolucao_sem_fluxo"
    | "outro"
  >("");

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
          tripla: { produto_id, ...q },
          qty,
          direcao,
          motivo,
          motivo_categoria: motivoCategoria,
        }),
      }),
    onSuccess: () => {
      toast.success("Ajuste registrado");
      setQty(1);
      setMotivo("");
      setMotivoCategoria("");
      setProduto(undefined);
      setSku("");
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const motivoTooShort = motivo.length > 0 && motivo.length < 3;
  // 3D: API exige tripla completa {produto_id, galpao_id, localizacao_id}
  // + qty>0 + motivo>=3 + motivo_categoria entre as 6 válidas. Sem empresa dona.
  const valid =
    !!produto_id &&
    !!q.galpao_id &&
    !!q.localizacao_id &&
    motivo.length >= 3 &&
    !!motivoCategoria &&
    qty > 0;

  return (
    <>
      <PageHeader
        title="Ajuste manual"
        subtitle="Entrada ou saída pontual com motivo registrado no ledger"
      />

      <h3 className="wms-sec-h">Localização do ajuste</h3>
      <div style={{ marginBottom: 16 }}>
        <TriplaPicker value={q} onChange={setQ} />
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
        label="Categoria"
        required
        hint="estruturada para apuração — selecione antes do motivo livre"
      >
        <select
          className="wms-input"
          value={motivoCategoria}
          onChange={(e) =>
            setMotivoCategoria(
              e.target.value as typeof motivoCategoria,
            )
          }
        >
          <option value="">Selecione…</option>
          <option value="avaria">Avaria</option>
          <option value="perda">Perda</option>
          <option value="achado">Achado</option>
          <option value="correcao_inventario">Correção de inventário</option>
          <option value="devolucao_sem_fluxo">Devolução sem fluxo</option>
          <option value="outro">Outro</option>
        </select>
      </Field>

      <Field
        label="Motivo"
        required
        hint={motivoTooShort ? "muito curto" : "mín. 3 caracteres"}
      >
        <textarea
          className="wms-textarea"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="detalhes do ajuste (NF, cliente, lote, etc.)"
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
          disabled={!valid || submit.isPending || !podeAjustar}
          title={!podeAjustar ? "Sem permissão pra aplicar ajuste manual" : ""}
          onClick={() => submit.mutate()}
        >
          <Icon name="sliders" size={11} />
          {submit.isPending ? "Salvando…" : "Registrar ajuste"}
        </button>
      </div>
    </>
  );
}

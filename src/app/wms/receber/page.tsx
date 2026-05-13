"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { Icon, PageHeader, Field, fmtNum } from "@/components/wms/ui/wms-ui";
import {
  ProdutoCombo,
  RECEBER_ORIGEM_OPTS,
  type ReceberOrigem,
  origemToBackend,
  hojeISODate,
  buildTimestamp,
  useGalpoes,
} from "@/components/wms/ui/modals";
import { useWmsModals } from "@/components/wms/wms-shell";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import type { Produto } from "@/lib/wms/types";

type Tab = "individual" | "lote";

export default function ReceberPage() {
  const [tab, setTab] = useState<Tab>("individual");

  return (
    <>
      <PageHeader
        title="Receber mercadoria"
        subtitle="Etapa 1 de 2 — registra entrada no dock. A guarda física (loc final + etiquetas) é feita em /wms/guarda."
      />

      <div className="wms-seg" style={{ marginBottom: 16, maxWidth: 360 }}>
        <button
          type="button"
          className={`wms-seg-btn ${tab === "individual" ? "is-active" : ""}`}
          onClick={() => setTab("individual")}
        >
          <Icon name="plus" size={11} /> Individual
        </button>
        <button
          type="button"
          className={`wms-seg-btn ${tab === "lote" ? "is-active" : ""}`}
          onClick={() => setTab("lote")}
        >
          <Icon name="box" size={11} /> Lote
        </button>
      </div>

      {tab === "individual" ? <TabIndividual /> : <TabLote />}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// TabIndividual: CTA pra abrir o ReceberModal já existente.

function TabIndividual() {
  const modals = useWmsModals();
  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 28,
        textAlign: "center",
      }}
    >
      <div style={{ marginBottom: 8 }}>
        <Icon name="plus" size={20} />
      </div>
      <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600 }}>
        Recebimento individual
      </h3>
      <p
        className="wms-td-mute"
        style={{ margin: "0 0 16px", fontSize: 12.5 }}
      >
        1 SKU por vez. A peça entra no dock RECEBIMENTO e cria uma pendência
        de guarda — a loc final é decidida no tablet em /wms/guarda.
      </p>
      <button
        type="button"
        className="wms-btn wms-btn-primary"
        onClick={() => modals.open("receber")}
      >
        <Icon name="plus" size={11} /> Iniciar recebimento
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// TabLote: bipagem múltipla. Todas as linhas entram em RECEBIMENTO; o
// plano de guarda foi removido (decidido na próxima etapa, /wms/guarda).

interface ItemLote {
  uid: string;
  produto: Produto | null;
  qty: string;
  custo: string;
}

function makeUid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface ReceberResponse {
  ok: boolean;
  pendencia_ids: string[];
  localizacao_recebimento_id: string;
}

function TabLote() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data: galpoes } = useGalpoes();
  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultGalpao = galpoesList.find((g) => g.empresas.length > 0);

  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const [empresaIdUser, setEmpresaIdUser] = useState<string | null>(null);
  const [nf, setNf] = useState("");
  const [origem, setOrigem] = useState<ReceberOrigem>("compra_manual");
  const [data, setData] = useState<string>(hojeISODate());
  const [obs, setObs] = useState("");
  const [itens, setItens] = useState<ItemLote[]>([
    { uid: makeUid(), produto: null, qty: "1", custo: "" },
  ]);
  const [imprimirAuto, setImprimirAuto] = useState(true);

  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";
  const galpao = galpoesList.find((g) => g.id === galpaoId);
  const empresasGalpao = galpao?.empresas ?? [];
  const empresaId = empresaIdUser ?? empresasGalpao[0]?.id ?? "";
  const today = hojeISODate();
  const isRetroativo = data !== today;

  const itensValidos = itens.filter(
    (it) => !!it.produto && !!it.qty && Number(it.qty) > 0,
  );
  const totalUn = itensValidos.reduce(
    (acc, it) => acc + Number(it.qty),
    0,
  );

  const submit = useMutation({
    mutationFn: async () => {
      const itensOut = itensValidos.map((it) => ({
        produto_id: it.produto!.id,
        qty: Number(it.qty),
        custo_unitario: it.custo ? Number(it.custo) : undefined,
      }));
      if (itensOut.length === 0) throw new Error("nenhum item válido");
      const origemFinal = isRetroativo
        ? "lancamento_retroativo"
        : origemToBackend(origem);
      const r = await sisoFetch("/api/wms/receber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_dona_id: empresaId,
          galpao_id: galpaoId,
          nf_referencia: nf || undefined,
          origem_tipo: origemFinal,
          observacoes: obs || undefined,
          data_recebimento: buildTimestamp(data),
          itens: itensOut,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      return (await r.json()) as ReceberResponse;
    },
    onSuccess: async (resp) => {
      toast.success(
        `Lote registrado: ${resp.pendencia_ids.length} pendência${resp.pendencia_ids.length > 1 ? "s" : ""} de guarda`,
      );

      // Dispara impressão do maço (fire-and-forget — não bloqueia a navegação)
      if (imprimirAuto) {
        sisoFetch("/api/wms/guarda/imprimir-lote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pendencia_ids: resp.pendencia_ids }),
        })
          .then(async (r) => {
            if (!r.ok) {
              const body = (await r.json().catch(() => ({}))) as {
                error?: string;
              };
              toast.warning(
                `Recebimento ok, mas falhou impressão: ${body.error ?? r.status}`,
              );
              return;
            }
            const out = (await r.json()) as {
              ok: boolean;
              totalEtiquetas?: number;
              totalFolhas?: number;
              fallbackEnvelope?: boolean;
            };
            toast.success(
              `${out.totalEtiquetas} etiquetas em ${out.totalFolhas} folhas${out.fallbackEnvelope ? " (impressora de envio — configure uma de produto)" : ""}`,
            );
          })
          .catch((err) => {
            toast.warning(`Recebimento ok, falha impressão: ${err.message}`);
          });
      }

      setItens([{ uid: makeUid(), produto: null, qty: "1", custo: "" }]);
      setNf("");
      setObs("");
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-ledger"] });
      qc.invalidateQueries({ queryKey: ["wms-produtos"] });
      qc.invalidateQueries({ queryKey: ["wms-cobertura-all"] });
      qc.invalidateQueries({ queryKey: ["wms-cobertura"] });
      qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
      qc.invalidateQueries({ queryKey: ["wms-guarda"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid =
    !!empresaId && !!galpaoId && itensValidos.length > 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 320px",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ── COLUNA ESQUERDA: captura ───────────────────────────────── */}
      <div>
        <h3 className="wms-sec-h">Configuração do lote</h3>
        <div className="wms-row-2">
          <Field label="Galpão">
            <select
              className="wms-select"
              value={galpaoId}
              onChange={(e) => {
                setGalpaoIdUser(e.target.value);
                setEmpresaIdUser(null);
              }}
            >
              {galpoesList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Empresa (dona)">
            <select
              className="wms-select"
              value={empresaId}
              onChange={(e) => setEmpresaIdUser(e.target.value)}
            >
              {empresasGalpao.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="wms-row-2">
          <Field label="NF de referência" hint="opcional">
            <input
              className="wms-input"
              value={nf}
              onChange={(e) => setNf(e.target.value)}
              placeholder="ex.: NF-7821"
            />
          </Field>
          <Field
            label="Data do recebimento"
            hint={isRetroativo ? "Retroativo" : "Hoje"}
          >
            <input
              className="wms-input"
              type="date"
              value={data}
              max={today}
              onChange={(e) => setData(e.target.value || today)}
            />
          </Field>
        </div>

        <Field label="Origem">
          <div className="wms-seg wms-seg-full">
            {RECEBER_ORIGEM_OPTS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`wms-seg-btn ${origem === o.id ? "is-active" : ""}`}
                onClick={() => setOrigem(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Observações" hint="opcional">
          <input
            className="wms-input"
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            placeholder="Aplicada ao lote inteiro"
          />
        </Field>

        <h3 className="wms-sec-h" style={{ marginTop: 16 }}>
          Itens ({itens.length})
        </h3>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginBottom: 12,
          }}
        >
          {itens.map((it, idx) => (
            <ItemLoteRow
              key={it.uid}
              item={it}
              onImageClick={(p) =>
                setLightbox({
                  imagens:
                    p.imagens && p.imagens.length > 0
                      ? p.imagens
                      : p.imagem_url
                        ? [p.imagem_url]
                        : [],
                  sku: p.sku,
                  descricao: p.descricao,
                })
              }
              onChange={(next) =>
                setItens((prev) =>
                  prev.map((x, i) => (i === idx ? next : x)),
                )
              }
              onRemove={() =>
                setItens((prev) =>
                  prev.length === 1
                    ? [
                        {
                          uid: makeUid(),
                          produto: null,
                          qty: "1",
                          custo: "",
                        },
                      ]
                    : prev.filter((_, i) => i !== idx),
                )
              }
            />
          ))}
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            style={{ borderStyle: "dashed", alignSelf: "flex-start" }}
            onClick={() =>
              setItens((p) => [
                ...p,
                { uid: makeUid(), produto: null, qty: "1", custo: "" },
              ])
            }
          >
            <Icon name="plus" size={11} /> Adicionar item
          </button>
        </div>
      </div>

      {/* ── COLUNA DIREITA: resumo + confirmar ─────────────────────── */}
      <aside
        style={{
          position: "sticky",
          top: 16,
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            <Icon name="box" size={12} /> Resumo
          </strong>
        </div>

        <div style={{ fontSize: 12, marginBottom: 10 }}>
          <div className="wms-row-2" style={{ marginBottom: 6 }}>
            <span className="wms-td-mute">Linhas</span>
            <span className="wms-mono wms-tar">{itensValidos.length}</span>
          </div>
          <div className="wms-row-2">
            <span className="wms-td-mute">Unidades</span>
            <span className="wms-mono wms-tar">{fmtNum(totalUn)}</span>
          </div>
        </div>

        <div
          style={{
            background: "var(--wms-c-faint)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-2)",
            padding: 10,
            fontSize: 11.5,
            marginBottom: 10,
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <Icon name="arrow-right" size={11} /> Tudo vai pra{" "}
            <span className="wms-mono">RECEBIMENTO</span>
          </div>
          <div className="wms-td-mute">
            Loc final é definida na fila de guarda (próxima etapa). O operador
            no tablet imprime etiqueta, bipa o QR da loc destino e confirma.
          </div>
        </div>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11.5,
            marginBottom: 10,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={imprimirAuto}
            onChange={(e) => setImprimirAuto(e.target.checked)}
          />
          Imprimir etiquetas ao confirmar (maço pra colar antes da guarda)
        </label>

        <button
          type="button"
          className="wms-btn wms-btn-primary"
          style={{ width: "100%", marginBottom: 8 }}
          disabled={!valid || submit.isPending}
          onClick={() => submit.mutate()}
        >
          <Icon name="check" size={11} />
          {submit.isPending
            ? "Enviando…"
            : `Confirmar lote (${itensValidos.length})`}
        </button>

        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          style={{ width: "100%", fontSize: 12 }}
          onClick={() => router.push("/wms/guarda")}
        >
          <Icon name="arrow-right" size={11} /> Ir pra fila de guarda
        </button>
      </aside>

      {lightbox && (
        <ProdutoLightbox
          imagens={lightbox.imagens}
          sku={lightbox.sku}
          descricao={lightbox.descricao}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// ItemLoteRow: linha de captura simplificada (sem loc por item).

function ItemLoteRow({
  item,
  onChange,
  onRemove,
  onImageClick,
}: {
  item: ItemLote;
  onChange: (next: ItemLote) => void;
  onRemove: () => void;
  onImageClick?: (p: Produto) => void;
}) {
  return (
    <div
      style={{
        background: "var(--wms-c-panel)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-2)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ProdutoCombo
            value={item.produto}
            onChange={(p) => onChange({ ...item, produto: p })}
            autoFocus={!item.produto}
            onImageClick={onImageClick}
          />
        </div>
        <input
          className="wms-input wms-mono wms-tar"
          type="number"
          min={1}
          value={item.qty}
          style={{ width: 80 }}
          onChange={(e) => onChange({ ...item, qty: e.target.value })}
          placeholder="qty"
        />
        <input
          className="wms-input wms-mono wms-tar"
          type="number"
          step="0.01"
          value={item.custo}
          style={{ width: 100 }}
          placeholder="custo"
          onChange={(e) => onChange({ ...item, custo: e.target.value })}
        />
        <button
          type="button"
          className="wms-btn-icon"
          title="Remover"
          onClick={onRemove}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  );
}

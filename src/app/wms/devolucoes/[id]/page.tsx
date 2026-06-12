"use client";
import { use, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import { usePermissoes } from "@/lib/auth-context";
import { TriplaPicker } from "@/components/wms/tripla-picker";
import {
  Icon,
  Modal,
  PageHeader,
  Field,
  StatusBadge,
  fmtDateTime,
} from "@/components/wms/ui/wms-ui";

type Classificacao = "integro" | "avariado" | "garantia" | "troca_sku";

interface DevRow {
  id: string;
  nota_fiscal_id: number | null;
  chave_acesso_nf?: string | null;
  /** Empresa **receptora física** da NF de devolução (quem recebeu de volta
   *  no galpão). NÃO é a vendedora original — essa só é resolvida no momento
   *  da classificação a partir da mov S da venda. */
  empresa_receptora?: { id?: string; nome?: string } | null;
  criado_em?: string;
  status?: string;
  classificacao?: string | null;
  classificada_em?: string | null;
  /** Itens do pedido de origem que tiveram troca de equivalência aplicada —
   *  a peça física que volta é o SUBSTITUTO, então a entrada vai nele. */
  trocas?: Array<{
    produto_substituto_id: string;
    sku_substituto: string;
    sku_vendido: string;
    troca_equivalencia_id: string | null;
  }>;
}

interface ProdutoMin {
  id: string;
  sku: string;
}

const CLASS_OPTS: Array<{
  id: Classificacao;
  letra: "A" | "B" | "C" | "D";
  label: string;
  desc: string;
  tone: "ok" | "warn" | "info";
}> = [
  {
    id: "integro",
    letra: "A",
    label: "Íntegro",
    desc: "Volta ao estoque normal",
    tone: "ok",
  },
  {
    id: "avariado",
    letra: "B",
    label: "Avariado",
    desc: "Vai para QUARENTENA",
    tone: "warn",
  },
  {
    id: "garantia",
    letra: "C",
    label: "Garantia",
    desc: "Vai para QUARENTENA + flag RMA",
    tone: "warn",
  },
  {
    id: "troca_sku",
    letra: "D",
    label: "Troca SKU",
    desc: "Substitui pelo SKU correto",
    tone: "info",
  },
];

export default function ClassificarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = usePermissoes();
  const podeClassificar = can("operacoes.devolucoes");
  const [classificacao, setClassificacao] =
    useState<Classificacao>("integro");
  const [produto_id, setProduto] = useState<string>();
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [q, setQ] = useState<{
    galpao_id?: string;
    localizacao_id?: string;
  }>({});
  const [observacoes, setObservacoes] = useState("");
  const [fornecedorId, setFornecedorId] = useState<string>("");
  const [desclassificarOpen, setDesclassificarOpen] = useState(false);
  const [desclassificarMotivo, setDesclassificarMotivo] = useState("");

  // Endpoint dedicado (P5) retorna a devolução mesmo quando ela já saiu da fila
  // (status≠'aguardando_classificacao') — necessário pro fluxo de desclassificar (P3).
  const { data: devResp } = useQuery({
    queryKey: ["wms-devolucao", id],
    queryFn: () =>
      wmsApi<{ devolucao: DevRow }>(`/api/wms/devolucoes/${id}`),
  });
  const dev = devResp?.devolucao;
  const jaClassificada = dev?.status === "classificada";
  // Troca de equivalência: peça que volta é o SUBSTITUTO (não o SKU vendido na
  // NF). Pega a 1ª troca do pedido pra sugerir o produto + avisar o operador.
  const troca = dev?.trocas?.[0];

  // Default do produto = substituto quando o pedido teve troca. Aplica uma vez
  // assim que a troca chega (pattern "ajustar state quando uma prop muda" —
  // setState em render, não em effect). Só pré-preenche se o operador ainda
  // não escolheu nada (não atropela edição manual).
  const [trocaAplicada, setTrocaAplicada] = useState<string>();
  if (troca && trocaAplicada !== troca.produto_substituto_id && !produto_id && !sku) {
    setTrocaAplicada(troca.produto_substituto_id);
    setProduto(troca.produto_substituto_id);
    setSku(troca.sku_substituto);
  }

  const { data: fornecedoresResp } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: () =>
      wmsApi<{ rows: Array<{ id: string; nome: string }> }>(
        "/api/wms/fornecedores",
      ),
    enabled: classificacao === "garantia",
  });
  const fornecedores = fornecedoresResp?.rows ?? [];

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
      wmsApi<{ ok: true }>(`/api/wms/devolucoes/${id}/classificar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classificacao,
          produto_id,
          qty,
          galpao_id: q.galpao_id,
          localizacao_id: q.localizacao_id,
          observacoes,
          fornecedor_id:
            classificacao === "garantia" ? fornecedorId : undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Devolução classificada");
      queryClient.invalidateQueries({ queryKey: ["wms-devolucoes"] });
      queryClient.invalidateQueries({ queryKey: ["wms-devolucoes-classificadas"] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      router.push("/wms/devolucoes");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const desclassificar = useMutation({
    mutationFn: (motivo: string) =>
      wmsApi<{ ok: true; movsEstornadas?: number }>(
        `/api/wms/devolucoes/${id}/desclassificar`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ motivo }),
        },
      ),
    onSuccess: (r) => {
      toast.success(
        r.movsEstornadas != null
          ? `Devolução desclassificada · ${r.movsEstornadas} mov(s) estornada(s)`
          : "Devolução desclassificada",
      );
      setDesclassificarOpen(false);
      setDesclassificarMotivo("");
      queryClient.invalidateQueries({ queryKey: ["wms-devolucao", id] });
      queryClient.invalidateQueries({ queryKey: ["wms-devolucoes"] });
      queryClient.invalidateQueries({ queryKey: ["wms-devolucoes-classificadas"] });
      queryClient.invalidateQueries({ queryKey: ["wms-estoque"] });
      queryClient.invalidateQueries({ queryKey: ["wms-ledger"] });
      router.push("/wms/devolucoes");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid =
    !!produto_id &&
    qty > 0 &&
    !!q.localizacao_id &&
    (classificacao !== "garantia" || !!fornecedorId);

  return (
    <>
      <PageHeader
        title={jaClassificada ? "Devolução classificada" : "Classificar devolução"}
        subtitle={
          jaClassificada
            ? "Já aplicada ao ledger — use 'Desclassificar' pra reverter"
            : "Defina A/B/C/D para aplicar ao ledger"
        }
      >
        {jaClassificada && podeClassificar && (
          <button
            type="button"
            className="wms-btn wms-btn-danger"
            onClick={() => {
              setDesclassificarMotivo("");
              setDesclassificarOpen(true);
            }}
            title="Estorna as movs geradas pela classificação e devolve pra aguardando_classificacao"
          >
            <Icon name="rotate" size={11} />
            Desclassificar
          </button>
        )}
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={() => router.push("/wms/devolucoes")}
        >
          <Icon name="x" size={11} />
          {jaClassificada ? "Voltar" : "Cancelar"}
        </button>
      </PageHeader>

      {dev && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            marginBottom: 16,
          }}
        >
          <div>
            <div className="wms-td-mute wms-mono" style={{ fontSize: 12 }}>
              NF {dev.nota_fiscal_id ?? "—"}
            </div>
            <h3
              style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 600 }}
            >
              {dev.empresa_receptora?.nome ?? "—"}
            </h3>
            <div className="wms-td-mute" style={{ fontSize: 11 }}>
              Empresa receptora da devolução
            </div>
            {dev.criado_em && (
              <div className="wms-td-mute" style={{ fontSize: 12 }}>
                Recebida em {fmtDateTime(dev.criado_em)}
              </div>
            )}
          </div>
          <StatusBadge status={dev.status ?? "aguardando_classificacao"} />
        </div>
      )}

      {jaClassificada && (
        <div className="wms-empty-block" style={{ marginBottom: 16 }}>
          <h3>Devolução já aplicada ao ledger</h3>
          <p>
            Pra reverter, clique em <strong>Desclassificar</strong> no topo. As
            movimentações geradas pela classificação serão estornadas e a
            devolução volta pra <strong>aguardando_classificacao</strong>{" "}
            permitindo nova classificação.
          </p>
        </div>
      )}

      {!jaClassificada && (
        <>
      {troca && (
        <div className="wms-hint-card" style={{ marginBottom: 16 }}>
          <Icon name="swap" size={14} />
          <span>
            <strong>⇄ Este pedido teve troca de equivalência</strong> — a peça
            enviada foi <strong className="wms-mono">{troca.sku_substituto}</strong>{" "}
            (vendido como{" "}
            <span className="wms-mono">{troca.sku_vendido}</span>), a entrada
            vai nesse produto.
          </span>
        </div>
      )}

      <h3 className="wms-sec-h">Classificação</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginBottom: 18,
        }}
      >
        {CLASS_OPTS.map((o) => {
          const active = classificacao === o.id;
          return (
            <button
              key={o.id}
              type="button"
              className="wms-card"
              style={{
                textAlign: "left",
                cursor: "pointer",
                borderColor: active
                  ? "var(--wms-c-fg)"
                  : "var(--wms-c-border-2)",
                borderWidth: active ? 1.5 : 1,
                background: active
                  ? "var(--wms-c-faint)"
                  : "var(--wms-c-panel)",
              }}
              onClick={() => setClassificacao(o.id)}
            >
              <div className="wms-card-body">
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {o.letra} — {o.label}
                </div>
                <div className="wms-td-mute" style={{ fontSize: 12 }}>
                  {o.desc}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <h3 className="wms-sec-h">Destino do estoque</h3>
      <div style={{ marginBottom: 16 }}>
        <TriplaPicker value={q} onChange={setQ} />
      </div>

      <Field label="Produto" required>
        <div style={{ display: "flex", gap: 8 }}>
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
            placeholder="SKU"
            style={{ flex: 1 }}
          />
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            style={{ width: 100 }}
          />
        </div>
      </Field>

      {classificacao === "garantia" && (
        <Field label="Fornecedor (RMA)" required>
          <select
            className="wms-input"
            value={fornecedorId}
            onChange={(e) => setFornecedorId(e.target.value)}
          >
            <option value="">— selecione o fornecedor —</option>
            {fornecedores.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Observações">
        <textarea
          className="wms-textarea"
          value={observacoes}
          onChange={(e) => setObservacoes(e.target.value)}
          placeholder="Estado físico, número de série, motivo declarado…"
          rows={3}
        />
      </Field>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 16,
          paddingTop: 16,
          borderTop: "1px solid var(--wms-c-border)",
        }}
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={() => router.push("/wms/devolucoes")}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={!valid || submit.isPending || !podeClassificar}
          title={!podeClassificar ? "Sem permissão pra classificar devolução" : ""}
          onClick={() => submit.mutate()}
        >
          <Icon name="check" size={11} />
          {submit.isPending ? "Aplicando…" : "Aplicar classificação ao ledger"}
        </button>
      </div>
        </>
      )}

      {desclassificarOpen && (
        <Modal
          title="Desclassificar devolução"
          subtitle={`NF ${dev?.nota_fiscal_id ?? "—"} · ${dev?.empresa_receptora?.nome ?? "—"}`}
          width={520}
          onClose={() =>
            !desclassificar.isPending && setDesclassificarOpen(false)
          }
          footer={
            <>
              <button
                type="button"
                className="wms-btn wms-btn-ghost"
                disabled={desclassificar.isPending}
                onClick={() => setDesclassificarOpen(false)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="wms-btn wms-btn-danger"
                disabled={
                  desclassificar.isPending ||
                  desclassificarMotivo.trim().length < 3
                }
                onClick={() =>
                  desclassificar.mutate(desclassificarMotivo.trim())
                }
              >
                <Icon name="rotate" size={11} />
                {desclassificar.isPending ? "Desclassificando…" : "Desclassificar"}
              </button>
            </>
          }
        >
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Estorna todas as movimentações geradas pela classificação anterior
            (match por janela temporal ±60s da classificada_em) e devolve o
            status pra <strong>aguardando_classificacao</strong> permitindo
            re-classificação imediata.
          </p>
          <label
            style={{
              fontSize: 12,
              fontWeight: 600,
              display: "block",
              marginBottom: 6,
            }}
          >
            Motivo (≥3 chars)
          </label>
          <textarea
            className="wms-textarea"
            value={desclassificarMotivo}
            onChange={(e) => setDesclassificarMotivo(e.target.value)}
            placeholder="Ex.: classificação errada (item íntegro foi marcado como avariado)"
            rows={3}
            autoFocus
            disabled={desclassificar.isPending}
          />
        </Modal>
      )}
    </>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader, Field, fmtNum } from "@/components/wms/ui/wms-ui";
import {
  ProdutoCombo,
  LocalizacaoCombo,
  RECEBER_ORIGEM_OPTS,
  type ReceberOrigem,
  origemToBackend,
  hojeISODate,
  buildTimestamp,
  useGalpoes,
  useLocalizacoes,
} from "@/components/wms/ui/modals";
import { useWmsModals } from "@/components/wms/wms-shell";
import type { Produto } from "@/lib/wms/types";

type Tab = "individual" | "lote";

export default function ReceberPage() {
  const [tab, setTab] = useState<Tab>("individual");

  return (
    <>
      <PageHeader
        title="Receber mercadoria"
        subtitle="Entrada no ledger com sugestão automática de putaway"
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
        1 SKU por vez, com sugestão automática de localização e revisão de custo
        médio.
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
// TabLote: bipagem múltipla com plano de guarda consolidado por loc.

interface ItemLote {
  uid: string;
  produto: Produto | null;
  qty: string;
  custo: string;
  /** Loc escolhida pelo operador. Se null, usa a sugerida pela query. */
  locIdOverride: string | null;
  locCodigoOverride: string | null;
}

interface PutawayResp {
  localizacao_id: string;
  codigo?: string;
  razao: string;
  locaisExistentes: Array<{
    localizacao_id: string;
    codigo: string;
    tipo: string;
    saldo: number;
  }>;
}

function makeUid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function TabLote() {
  const qc = useQueryClient();
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultGalpao = galpoesList.find((g) => g.empresas.length > 0);

  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const [empresaIdUser, setEmpresaIdUser] = useState<string | null>(null);
  const [nf, setNf] = useState("");
  const [origem, setOrigem] = useState<ReceberOrigem>("compra_manual");
  const [data, setData] = useState<string>(hojeISODate());
  const [obs, setObs] = useState("");
  const [itens, setItens] = useState<ItemLote[]>([
    { uid: makeUid(), produto: null, qty: "1", custo: "", locIdOverride: null, locCodigoOverride: null },
  ]);

  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";
  const galpao = galpoesList.find((g) => g.id === galpaoId);
  const empresasGalpao = galpao?.empresas ?? [];
  const empresaId = empresaIdUser ?? empresasGalpao[0]?.id ?? "";
  const today = hojeISODate();
  const isRetroativo = data !== today;

  // Locs do galpão pra resolver código quando operador escolhe via combo.
  const { data: locsResp } = useLocalizacoes(galpaoId || null);
  const locsById = useMemo(() => {
    const m = new Map<string, { codigo: string; tipo: string }>();
    (locsResp?.rows ?? []).forEach((l) =>
      m.set(l.id, { codigo: l.codigo, tipo: l.tipo }),
    );
    return m;
  }, [locsResp]);

  // Uma query de putaway por item que tem produto resolvido.
  const putawayQueries = useQueries({
    queries: itens.map((it) => ({
      queryKey: ["wms-receber-lote-putaway", it.produto?.id, empresaId, galpaoId],
      queryFn: () =>
        wmsApi<PutawayResp>(
          `/api/wms/receber?produto_id=${it.produto!.id}&empresa_id=${empresaId}&galpao_id=${galpaoId}`,
        ),
      enabled: !!(it.produto?.id && empresaId && galpaoId),
      staleTime: 30 * 1000,
    })),
  });

  // Plano de guarda agrupado por localização (resolvida ou pendente).
  const plano = useMemo(() => {
    const grupos = new Map<
      string,
      {
        locId: string | null;
        locCodigo: string;
        locTipo: string;
        itens: Array<{ uid: string; sku: string; qty: number }>;
      }
    >();
    itens.forEach((it, idx) => {
      if (!it.produto || !it.qty || Number(it.qty) <= 0) return;
      const sug = putawayQueries[idx]?.data;
      const locId = it.locIdOverride ?? sug?.localizacao_id ?? null;
      const fromLocs = locId ? locsById.get(locId) : undefined;
      const locCodigo =
        fromLocs?.codigo ??
        it.locCodigoOverride ??
        sug?.codigo ??
        (locId ? locId.slice(0, 8) : "Sem localização");
      const locTipo =
        fromLocs?.tipo ??
        sug?.locaisExistentes.find((l) => l.localizacao_id === locId)?.tipo ??
        "";
      const key = locId ?? "__pending__";
      const grp = grupos.get(key) ?? {
        locId,
        locCodigo,
        locTipo,
        itens: [],
      };
      grp.itens.push({ uid: it.uid, sku: it.produto.sku, qty: Number(it.qty) });
      grupos.set(key, grp);
    });
    return Array.from(grupos.values()).sort((a, b) => {
      if (a.locId === null) return 1;
      if (b.locId === null) return -1;
      return a.locCodigo.localeCompare(b.locCodigo);
    });
  }, [itens, putawayQueries, locsById]);

  const totaisPlano = useMemo(() => {
    let totalUn = 0;
    let totalLinhas = 0;
    let pendentes = 0;
    plano.forEach((g) => {
      g.itens.forEach((i) => {
        totalUn += i.qty;
        totalLinhas++;
      });
      if (g.locId === null) pendentes += g.itens.length;
    });
    return { totalUn, totalLinhas, pendentes };
  }, [plano]);

  const submit = useMutation({
    mutationFn: async () => {
      // Valida cada item: precisa ter produto, qty>0 e loc resolvida.
      const itensOut: Array<{
        produto_id: string;
        qty: number;
        custo_unitario?: number;
        localizacao_id: string;
      }> = [];
      itens.forEach((it, idx) => {
        if (!it.produto) return;
        const qtyN = Number(it.qty);
        if (!qtyN || qtyN <= 0) return;
        const sug = putawayQueries[idx]?.data;
        const locId = it.locIdOverride ?? sug?.localizacao_id;
        if (!locId) {
          throw new Error(`SKU ${it.produto.sku} sem localização resolvida`);
        }
        itensOut.push({
          produto_id: it.produto.id,
          qty: qtyN,
          custo_unitario: it.custo ? Number(it.custo) : undefined,
          localizacao_id: locId,
        });
      });
      if (itensOut.length === 0) {
        throw new Error("nenhum item válido pra enviar");
      }
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
      return itensOut.length;
    },
    onSuccess: (n) => {
      toast.success(`Lote registrado: ${n} item${n > 1 ? "ns" : ""}`);
      setItens([
        { uid: makeUid(), produto: null, qty: "1", custo: "", locIdOverride: null, locCodigoOverride: null },
      ]);
      setNf("");
      setObs("");
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-ledger"] });
      qc.invalidateQueries({ queryKey: ["wms-produtos"] });
      qc.invalidateQueries({ queryKey: ["wms-cobertura-all"] });
      qc.invalidateQueries({ queryKey: ["wms-cobertura"] });
      qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
      qc.invalidateQueries({ queryKey: ["wms-produto"] });
      qc.invalidateQueries({ queryKey: ["wms-produto-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-produto-ledger"] });
      qc.invalidateQueries({ queryKey: ["wms-produto-cobertura"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const itensValidos = itens.filter((it, idx) => {
    if (!it.produto) return false;
    if (!it.qty || Number(it.qty) <= 0) return false;
    const sug = putawayQueries[idx]?.data;
    return !!(it.locIdOverride ?? sug?.localizacao_id);
  });
  const valid =
    !!empresaId && !!galpaoId && itensValidos.length > 0 && totaisPlano.pendentes === 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 16, alignItems: "start" }}>
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
                // Limpa overrides de loc — outro galpão tem outras locs
                setItens((prev) =>
                  prev.map((it) => ({ ...it, locIdOverride: null, locCodigoOverride: null })),
                );
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
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
          {itens.map((it, idx) => (
            <ItemLoteRow
              key={it.uid}
              item={it}
              putaway={putawayQueries[idx]?.data}
              isFetching={!!putawayQueries[idx]?.isFetching}
              galpaoId={galpaoId}
              locsById={locsById}
              canResolve={!!empresaId && !!galpaoId}
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
                          locIdOverride: null,
                          locCodigoOverride: null,
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
                {
                  uid: makeUid(),
                  produto: null,
                  qty: "1",
                  custo: "",
                  locIdOverride: null,
                  locCodigoOverride: null,
                },
              ])
            }
          >
            <Icon name="plus" size={11} /> Adicionar item
          </button>
        </div>
      </div>

      {/* ── COLUNA DIREITA: plano de guarda ────────────────────────── */}
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
            <Icon name="box" size={12} /> Plano de guarda
          </strong>
          <span className="wms-td-mute" style={{ fontSize: 11 }}>
            {totaisPlano.totalLinhas} linha
            {totaisPlano.totalLinhas !== 1 ? "s" : ""} ·{" "}
            {fmtNum(totaisPlano.totalUn)} un
          </span>
        </div>

        {plano.length === 0 && (
          <div className="wms-td-mute" style={{ fontSize: 12 }}>
            Bipe SKUs ao lado pra gerar o plano automaticamente.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plano.map((g) => (
            <div
              key={g.locId ?? "pending"}
              style={{
                background: g.locId === null ? "var(--wms-c-warn-faint, #fff7e6)" : "var(--wms-c-faint)",
                border: g.locId === null ? "1px solid #f0c36d" : "1px solid var(--wms-c-border)",
                borderRadius: "var(--wms-r-2)",
                padding: 10,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span className="wms-mono" style={{ fontSize: 12, fontWeight: 600 }}>
                  {g.locCodigo}
                </span>
                <span className="wms-td-mute" style={{ fontSize: 11 }}>
                  {g.locTipo}
                  {g.locTipo ? " · " : ""}
                  {g.itens.length} SKU{g.itens.length > 1 ? "s" : ""}
                </span>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {g.itens.map((i) => (
                  <li
                    key={i.uid}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11.5,
                      padding: "2px 0",
                    }}
                  >
                    <span className="wms-mono">{i.sku}</span>
                    <span className="wms-mono wms-tar">{fmtNum(i.qty)} un</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {totaisPlano.pendentes > 0 && (
          <div
            className="wms-td-mute"
            style={{ marginTop: 10, fontSize: 11, color: "#a16207" }}
          >
            <Icon name="alert" size={11} /> {totaisPlano.pendentes} item
            {totaisPlano.pendentes > 1 ? "ns" : ""} sem localização — escolha
            antes de confirmar
          </div>
        )}

        <button
          type="button"
          className="wms-btn wms-btn-primary"
          style={{ marginTop: 12, width: "100%" }}
          disabled={!valid || submit.isPending}
          onClick={() => submit.mutate()}
        >
          <Icon name="check" size={11} />
          {submit.isPending
            ? "Enviando…"
            : `Confirmar lote (${itensValidos.length})`}
        </button>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// ItemLoteRow: linha de captura de 1 SKU dentro do lote.

function ItemLoteRow({
  item,
  putaway,
  isFetching,
  galpaoId,
  locsById,
  canResolve,
  onChange,
  onRemove,
}: {
  item: ItemLote;
  putaway?: PutawayResp;
  isFetching: boolean;
  galpaoId: string;
  locsById: Map<string, { codigo: string; tipo: string }>;
  canResolve: boolean;
  onChange: (next: ItemLote) => void;
  onRemove: () => void;
}) {
  const [trocandoLoc, setTrocandoLoc] = useState(false);

  const locIdAtual = item.locIdOverride ?? putaway?.localizacao_id ?? "";
  // Resolve o codigo na ordem: override explicito (chips) > catalogo de locs
  // do galpao (cobre selecoes via combo, que so trazem o id) > sugestao do
  // putaway > vazio. Sem o lookup em locsById, selecoes via combo exibiriam
  // o codigo da sugestao original em vez da loc escolhida.
  const locCodigoAtual =
    item.locCodigoOverride ??
    (locIdAtual ? locsById.get(locIdAtual)?.codigo : undefined) ??
    putaway?.codigo ??
    "";
  const isSugestao =
    !!putaway && locIdAtual === putaway.localizacao_id && !item.locIdOverride;

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
            onChange={(p) =>
              onChange({
                ...item,
                produto: p,
                locIdOverride: null,
                locCodigoOverride: null,
              })
            }
            autoFocus={!item.produto}
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

      {/* Linha de localização (sugerida + trocar) */}
      {item.produto && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            paddingLeft: 4,
            fontSize: 11.5,
          }}
        >
          {!canResolve && (
            <span className="wms-td-mute">Escolha empresa+galpão acima</span>
          )}
          {canResolve && isFetching && (
            <span className="wms-td-mute">Buscando localização…</span>
          )}
          {canResolve && !isFetching && locIdAtual && (
            <>
              <Icon name="arrow-right" size={11} />
              <span className="wms-mono" style={{ fontWeight: 600 }}>
                {locCodigoAtual}
              </span>
              {isSugestao && putaway?.razao && (
                <span className="wms-td-mute">
                  <Icon name="sparkle" size={10} /> {putaway.razao}
                </span>
              )}
              {!isSugestao && (
                <span className="wms-td-mute">(escolhida pelo operador)</span>
              )}
              <button
                type="button"
                className="wms-btn-link"
                onClick={() => setTrocandoLoc((v) => !v)}
              >
                {trocandoLoc ? "Cancelar" : "Trocar loc"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Locs onde SKU já tem saldo (chips clicáveis) */}
      {item.produto &&
        canResolve &&
        !isFetching &&
        (putaway?.locaisExistentes.length ?? 0) > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              paddingLeft: 4,
            }}
          >
            <span
              className="wms-td-mute"
              style={{ fontSize: 11, alignSelf: "center" }}
            >
              <Icon name="box" size={10} /> Onde já tem saldo:
            </span>
            {putaway!.locaisExistentes.map((l) => {
              const isSelected = l.localizacao_id === locIdAtual;
              return (
                <button
                  key={l.localizacao_id}
                  type="button"
                  className={`wms-btn wms-btn-sm ${isSelected ? "wms-btn-primary" : "wms-btn-ghost"}`}
                  style={{ fontSize: 11 }}
                  onClick={() =>
                    onChange({
                      ...item,
                      locIdOverride: l.localizacao_id,
                      locCodigoOverride: l.codigo,
                    })
                  }
                  title={`${fmtNum(l.saldo)} un. em ${l.codigo}`}
                >
                  <span className="wms-mono">{l.codigo}</span>
                  <span
                    className="wms-td-mute"
                    style={{ marginLeft: 6, fontSize: 10.5 }}
                  >
                    {fmtNum(l.saldo)} un · {l.tipo}
                  </span>
                </button>
              );
            })}
          </div>
        )}

      {/* Combo pra escolher loc nova / qualquer loc do galpão */}
      {trocandoLoc && (
        <div style={{ paddingLeft: 4 }}>
          <LocalizacaoCombo
            galpaoId={galpaoId || null}
            value={locIdAtual}
            onChange={(id) => {
              // O combo emite onChange("") enquanto o operador digita pra
              // sinalizar "seleção em edição". Ignoramos esse sinal — só
              // fechamos o combo quando há um id real selecionado.
              if (!id) return;
              onChange({
                ...item,
                locIdOverride: id,
                locCodigoOverride: null,
              });
              setTrocandoLoc(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

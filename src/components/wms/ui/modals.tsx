"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon, Modal, Field, fmtNum, useAutoFocus } from "./wms-ui";
import { wmsApi } from "@/lib/wms/api-client";
import { sisoFetch } from "@/lib/auth-context";
import type { Produto, Localizacao, TipoLocalizacao } from "@/lib/wms/types";

// ──────────────────────────────────────────────────────────────────
// Empresa / Galpão queries — leves, com cache de 5min

export interface EmpresaLite {
  id: string;
  nome: string;
  cnpj: string | null;
  galpao_id: string | null;
}

export interface GalpaoLite {
  id: string;
  nome: string;
  descricao: string | null;
  empresas: EmpresaLite[];
}

export function useGalpoes() {
  return useQuery({
    queryKey: ["wms-modal-galpoes"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/admin/galpoes");
      if (!r.ok) throw new Error("falha ao listar galpões");
      const json = (await r.json()) as Array<{
        id: string;
        nome: string;
        descricao: string | null;
        siso_empresas?: Array<{
          id: string;
          nome: string;
          cnpj: string;
          ativo?: boolean;
        }>;
      }>;
      return (json ?? []).map<GalpaoLite>((g) => ({
        id: g.id,
        nome: g.nome,
        descricao: g.descricao,
        empresas: (g.siso_empresas ?? [])
          .filter((e) => e.ativo !== false)
          .map((e) => ({
            id: e.id,
            nome: e.nome,
            cnpj: e.cnpj,
            galpao_id: g.id,
          })),
      }));
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useLocalizacoes(galpaoId: string | null) {
  return useQuery({
    queryKey: ["wms-modal-locs", galpaoId],
    queryFn: () =>
      wmsApi<{ rows: Localizacao[] }>(
        `/api/wms/localizacoes?galpao_id=${galpaoId}`,
      ),
    enabled: !!galpaoId,
    staleTime: 60 * 1000,
  });
}

export function useProdutoSearch(q: string) {
  return useQuery({
    queryKey: ["wms-modal-produtos", q],
    queryFn: () =>
      wmsApi<{ rows: Produto[]; total: number }>(
        `/api/wms/produtos?q=${encodeURIComponent(q)}&limit=8`,
      ),
    enabled: q.length >= 2,
    staleTime: 30 * 1000,
  });
}

// ──────────────────────────────────────────────────────────────────
// ProdutoCombo

export function ProdutoCombo({
  value,
  onChange,
  autoFocus = false,
  onImageClick,
}: {
  value: Produto | null;
  onChange: (p: Produto | null) => void;
  autoFocus?: boolean;
  /** Quando passado, clicar na imagem da seleção atual chama este handler
   *  (tipicamente abre um lightbox). Sem ele, a imagem é estática. */
  onImageClick?: (p: Produto) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useAutoFocus<HTMLInputElement>(autoFocus && !value);
  const { data, isFetching } = useProdutoSearch(q);
  const opts = data?.rows ?? [];

  if (value && !open) {
    return (
      <div className="wms-picker">
        <div
          className="wms-picker-selected"
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          {value.imagem_url && (
            <img
              src={value.imagem_url}
              alt=""
              loading="lazy"
              className={`wms-thumb wms-thumb-sm ${
                onImageClick ? "wms-thumb-click" : ""
              }`}
              onClick={
                onImageClick ? () => onImageClick(value) : undefined
              }
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="wms-mono">{value.sku}</div>
            <div className="wms-td-mute" style={{ fontSize: 12 }}>
              {value.descricao}
            </div>
          </div>
          <button
            className="wms-btn-link"
            onClick={() => {
              onChange(null);
              setOpen(true);
              setQ("");
            }}
          >
            Trocar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wms-picker">
      <div className="wms-search-wrap">
        <Icon name="search" size={13} />
        <input
          ref={ref}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Buscar SKU, descrição ou GTIN…"
        />
      </div>
      {open && q.length >= 2 && (
        <div className="wms-picker-list">
          {isFetching && (
            <div className="wms-picker-empty">Buscando…</div>
          )}
          {!isFetching && opts.length === 0 && (
            <div className="wms-picker-empty">Nenhum produto encontrado.</div>
          )}
          {opts.map((p) => (
            <button
              key={p.id}
              className="wms-picker-item"
              onClick={() => {
                onChange(p);
                setOpen(false);
                setQ("");
              }}
            >
              {p.imagem_url && (
                <img
                  src={p.imagem_url}
                  alt=""
                  loading="lazy"
                  className="wms-thumb wms-thumb-xs"
                />
              )}
              <span className="wms-mono">{p.sku}</span>
              <span className="wms-picker-desc">{p.descricao}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// LocalizacaoCombo — input com autocomplete + criar inline.
// Substitui o antigo <select>: o operador digita o código (ex. "A-01-03"),
// vê sugestões filtradas, e se o código não existir, Enter ou o botão
// "Adicionar" criam a localização e a selecionam.

export function LocalizacaoCombo({
  galpaoId,
  value,
  onChange,
  allowedTipos,
  placeholder,
  allowCreate = true,
}: {
  galpaoId: string | null;
  value: string;
  onChange: (id: string) => void;
  allowedTipos?: TipoLocalizacao[];
  placeholder?: string;
  /** Permite criar localização inline quando o código digitado não existe.
   *  Default true. Use false em fluxos onde criar uma nova loc seria um erro
   *  (ex: transferência inter-galpão — operador digita errado e cria loc órfã
   *  sem saldo). */
  allowCreate?: boolean;
}) {
  const qc = useQueryClient();
  const { data } = useLocalizacoes(galpaoId);
  const todas = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (l) => l.ativo && (!allowedTipos || allowedTipos.includes(l.tipo)),
      ),
    [data, allowedTipos],
  );
  const selected = todas.find((l) => l.id === value) ?? null;

  const [q, setQ] = useState(selected?.codigo ?? "");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sincroniza o texto exibido quando o valor selecionado muda externamente
  useEffect(() => {
    setQ(selected?.codigo ?? "");
  }, [value, selected?.codigo]);

  // Quando o galpão muda, limpa input se o valor anterior não está mais no domínio
  useEffect(() => {
    if (value && !todas.some((l) => l.id === value)) {
      onChange("");
      setQ("");
    }
  }, [galpaoId, todas, value, onChange]);

  const ql = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      ql === ""
        ? todas.slice(0, 12)
        : todas
            .filter(
              (l) =>
                l.codigo.toLowerCase().includes(ql) ||
                (l.descricao ?? "").toLowerCase().includes(ql),
            )
            .slice(0, 12),
    [todas, ql],
  );

  const queryNorm = q.trim().toUpperCase();
  const exact = todas.find((l) => l.codigo.toUpperCase() === queryNorm);
  const showAdd =
    allowCreate && queryNorm.length > 0 && !exact && !adding && !!galpaoId;
  const showNoMatch =
    !allowCreate && queryNorm.length > 0 && !exact && filtered.length === 0;

  async function commitAdd() {
    if (!galpaoId || !queryNorm) return;
    setAdding(true);
    try {
      const r = await sisoFetch("/api/wms/localizacoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_id: galpaoId,
          codigo: queryNorm,
          tipo: allowedTipos?.[0] ?? "picking",
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const loc = (await r.json()) as Localizacao;
      toast.success(`Localização ${loc.codigo} criada`);
      await qc.invalidateQueries({ queryKey: ["wms-modal-locs", galpaoId] });
      await qc.invalidateQueries({ queryKey: ["wms-locs", galpaoId] });
      onChange(loc.id);
      setQ(loc.codigo);
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  function commitSelect(loc: Localizacao) {
    onChange(loc.id);
    setQ(loc.codigo);
    setOpen(false);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) =>
        Math.min(h + 1, filtered.length + (showAdd ? 1 : 0) - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (exact) {
        commitSelect(exact);
        return;
      }
      const items = filtered;
      if (highlight < items.length) {
        commitSelect(items[highlight]);
      } else if (showAdd) {
        commitAdd();
      } else if (items.length === 1) {
        commitSelect(items[0]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQ(selected?.codigo ?? "");
    }
  }

  const disabled = !galpaoId;

  return (
    <div className="wms-picker">
      <div
        className="wms-search-wrap"
        style={disabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
      >
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          className="wms-mono"
          value={q}
          disabled={disabled}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setHighlight(0);
            // Se o usuário começou a editar, limpa a seleção atual.
            if (selected && selected.codigo !== e.target.value) {
              onChange("");
            }
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Pequeno delay para permitir clique nos itens do dropdown
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={handleKey}
          placeholder={
            disabled
              ? "Escolha o galpão primeiro"
              : placeholder ?? "Bipar ou digitar código…"
          }
        />
      </div>
      {open && !disabled && (filtered.length > 0 || showAdd || showNoMatch) && (
        <div className="wms-picker-list">
          {filtered.map((l, i) => (
            <button
              key={l.id}
              type="button"
              className="wms-picker-item"
              data-highlight={highlight === i ? "true" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commitSelect(l)}
            >
              <span className="wms-mono">{l.codigo}</span>
              <span className="wms-picker-desc">
                <span className="wms-td-mute">{l.tipo}</span>
                {l.descricao ? ` · ${l.descricao}` : ""}
              </span>
            </button>
          ))}
          {showAdd && (
            <button
              type="button"
              className="wms-picker-item"
              data-highlight={highlight === filtered.length ? "true" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(filtered.length)}
              disabled={adding}
              onClick={commitAdd}
            >
              <Icon name="plus" size={11} />
              <span>
                Adicionar <span className="wms-mono">{queryNorm}</span>
              </span>
              <span
                className="wms-td-mute"
                style={{ fontSize: 11.5, marginLeft: "auto" }}
              >
                {adding ? "criando…" : "Enter ↵"}
              </span>
            </button>
          )}
          {showNoMatch && (
            <div className="wms-picker-empty">
              <Icon name="alert" size={11} /> Nenhuma localização com esse
              código. Criação não permitida aqui.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Receber

interface ModalProdutoSeed {
  produto?: Produto;
}

export type ReceberOrigem = "compra_manual" | "nf_compra" | "devolucao";

export const RECEBER_ORIGEM_OPTS: { id: ReceberOrigem; label: string }[] = [
  { id: "compra_manual", label: "Compra manual" },
  { id: "nf_compra", label: "NF de compra" },
  { id: "devolucao", label: "Devolução" },
];

// Mapeia escolha do UI pro tipo canônico de origem usado no ledger.
// Retroativo não é uma opção: é inferido da data escolhida (data < hoje).
export function origemToBackend(o: ReceberOrigem): string {
  switch (o) {
    case "devolucao":
      return "nf_devolucao_cliente";
    case "compra_manual":
    case "nf_compra":
    default:
      return "compra_manual";
  }
}

// Data de hoje em YYYY-MM-DD no timezone local.
export function hojeISODate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Constrói timestamp ISO a partir de date string + hora atual local.
// Preserva hora-do-dia no audit trail; quando a data é hoje, vira ~now().
export function buildTimestamp(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const now = new Date();
  return new Date(
    y,
    m - 1,
    d,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ).toISOString();
}

// ──────────────────────────────────────────────────────────────────
// Saída / Ajuste

export function AjusteModal({
  seed,
  onClose,
}: {
  seed?: ModalProdutoSeed;
  onClose: () => void;
}) {
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultGalpao = galpoesList[0];

  const [pid, setPid] = useState<Produto | null>(seed?.produto ?? null);
  const [qty, setQty] = useState("");
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [motivo, setMotivo] = useState("");
  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const [locIdUser, setLocIdUser] = useState<string | null>(null);
  const qc = useQueryClient();

  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";
  const locId = locIdUser ?? "";

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/ajuste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripla: {
            produto_id: pid!.id,
            galpao_id: galpaoId,
            localizacao_id: locId,
          },
          qty: Number(qty),
          direcao,
          motivo,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      const sign = direcao === "entrada" ? "+" : "−";
      toast.success(`Ajuste registrado: ${sign}${fmtNum(Number(qty))} de ${pid!.sku}`);
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
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const valid =
    !!pid &&
    !!galpaoId &&
    !!locId &&
    Number(qty) > 0 &&
    motivo.trim().length >= 3;

  return (
    <Modal
      title="Ajuste de estoque"
      subtitle="Entrada ou saída avulsa, sem NF. Motivo obrigatório (mín. 3 chars)."
      onClose={onClose}
      footer={
        <>
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className={
              direcao === "entrada"
                ? "wms-btn wms-btn-primary"
                : "wms-btn wms-btn-danger"
            }
            disabled={!valid || mut.isPending}
            onClick={() => mut.mutate()}
          >
            <Icon name={direcao === "entrada" ? "plus" : "minus"} size={11} />
            {mut.isPending
              ? "Enviando…"
              : `Confirmar ${direcao === "entrada" ? "entrada" : "saída"}`}
          </button>
        </>
      }
    >
      <Field label="Produto" required>
        <ProdutoCombo value={pid} onChange={setPid} autoFocus={!seed?.produto} />
      </Field>

      <Field label="Direção">
        <div className="wms-seg wms-seg-full">
          {(["saida", "entrada"] as const).map((d) => (
            <button
              key={d}
              className={`wms-seg-btn ${direcao === d ? "is-active" : ""}`}
              onClick={() => setDirecao(d)}
            >
              {d === "saida" ? "Saída (−)" : "Entrada (+)"}
            </button>
          ))}
        </div>
      </Field>

      <div className="wms-row-2">
        <Field label="Galpão">
          <select
            className="wms-select"
            value={galpaoId}
            onChange={(e) => {
              setGalpaoIdUser(e.target.value);
              setLocIdUser(null);
            }}
          >
            {galpoesList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Localização" required>
          <LocalizacaoCombo
            galpaoId={galpaoId}
            value={locId}
            onChange={(v) => setLocIdUser(v)}
          />
        </Field>
      </div>

      <Field label="Quantidade" required>
        <input
          className="wms-input"
          type="number"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="0"
        />
      </Field>

      <Field label="Motivo" required hint="Mínimo 3 caracteres. Será gravado no ledger.">
        <textarea
          className="wms-textarea"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Ex: Avariado em manuseio, achado no inventário…"
        />
      </Field>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────
// Transferência inter-galpão

interface TransferItem {
  produto: Produto | null;
  qty: string;
  locOrigem: string;
}

interface LocalSaldo {
  localizacao_id: string;
  codigo: string;
  tipo: string;
  saldo: number;
}

function TransferItemRow({
  item,
  idx,
  galOrig,
  canRemove,
  onChange,
  onRemove,
}: {
  item: TransferItem;
  idx: number;
  galOrig: string;
  canRemove: boolean;
  onChange: (patch: Partial<TransferItem>) => void;
  onRemove: () => void;
}) {
  // Busca localizações onde o SKU já tem saldo no galpão origem.
  // Reusa o GET /api/wms/receber que já agrega esse dado (3D: sem empresa).
  const ready = !!item.produto && !!galOrig;
  const sugQuery = useQuery({
    queryKey: ["wms-putaway", item.produto?.id, galOrig],
    queryFn: () =>
      wmsApi<{
        localizacao_id: string;
        codigo?: string;
        razao: string;
        locaisExistentes: LocalSaldo[];
      } | null>(
        `/api/wms/receber?produto_id=${item.produto!.id}&galpao_id=${galOrig}`,
      ),
    enabled: ready,
    staleTime: 30 * 1000,
  });

  const locais = useMemo(
    () => sugQuery.data?.locaisExistentes ?? [],
    [sugQuery.data],
  );

  // Auto-seleciona a primeira (maior saldo em picking) quando o produto muda
  // e ainda não há escolha manual. onChange é estável (useCallback no parent).
  // Quando há apenas uma loc, também auto-preenche qty (conveniência).
  useEffect(() => {
    if (item.produto && !item.locOrigem && locais.length > 0) {
      const patch: Partial<TransferItem> = { locOrigem: locais[0].localizacao_id };
      if (locais.length === 1 && !item.qty) {
        patch.qty = String(Number(locais[0].saldo));
      }
      onChange(patch);
    }
  }, [item.produto, item.locOrigem, item.qty, locais, onChange]);

  const locSel = locais.find((l) => l.localizacao_id === item.locOrigem);
  const qtyNum = Number(item.qty);
  const overQty = !!locSel && qtyNum > Number(locSel.saldo);

  return (
    <div
      style={{
        padding: 10,
        background: "var(--wms-c-faint)",
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 90px 1fr 32px",
          gap: 8,
          alignItems: "end",
        }}
      >
        <Field label={idx === 0 ? "Produto" : undefined} required>
          <ProdutoCombo
            value={item.produto}
            onChange={(p) =>
              onChange({ produto: p, locOrigem: "" })
            }
          />
        </Field>
        <Field
          label={idx === 0 ? "Qty" : undefined}
          required
          hint={
            locSel
              ? `disp: ${fmtNum(Number(locSel.saldo))}`
              : undefined
          }
        >
          <input
            className={`wms-input wms-mono wms-tar ${overQty ? "wms-input-danger" : ""}`}
            type="number"
            min="1"
            value={item.qty}
            onChange={(e) => onChange({ qty: e.target.value })}
            placeholder="0"
          />
        </Field>
        <Field
          label={idx === 0 ? "Localização origem" : undefined}
          required
        >
          <LocalizacaoCombo
            galpaoId={galOrig || null}
            value={item.locOrigem}
            onChange={(v) => onChange({ locOrigem: v })}
            allowCreate={false}
          />
        </Field>
        <button
          type="button"
          className="wms-btn-icon"
          onClick={onRemove}
          disabled={!canRemove}
          title="Remover item"
          style={{ marginBottom: 4 }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {ready && locais.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px dashed var(--wms-c-border)",
          }}
        >
          <span
            className="wms-td-mute"
            style={{ fontSize: 11, alignSelf: "center", marginRight: 2 }}
          >
            <Icon name="box" size={10} /> Onde tem saldo:
          </span>
          {locais.map((l) => {
            const isSelected = l.localizacao_id === item.locOrigem;
            return (
              <button
                key={l.localizacao_id}
                type="button"
                onClick={() =>
                  onChange({ locOrigem: l.localizacao_id })
                }
                className={`wms-btn wms-btn-sm ${
                  isSelected ? "wms-btn-primary" : "wms-btn-ghost"
                }`}
                style={{ fontSize: 11 }}
              >
                <span className="wms-mono">{l.codigo}</span>
                <span
                  className="wms-td-mute"
                  style={{ marginLeft: 5, fontSize: 10.5 }}
                >
                  {fmtNum(Number(l.saldo))} un · {l.tipo}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {ready && !sugQuery.isLoading && locais.length === 0 && (
        <div
          className="wms-td-mute"
          style={{
            fontSize: 11,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px dashed var(--wms-c-border)",
          }}
        >
          <Icon name="alert" size={10} /> Esse SKU não tem saldo no galpão
          origem.
        </div>
      )}
      {overQty && (
        <div
          className="wms-td-warn"
          style={{ fontSize: 11, marginTop: 6 }}
        >
          <Icon name="alert" size={10} /> Qty maior que o saldo disponível na
          localização ({fmtNum(Number(locSel!.saldo))}).
        </div>
      )}
    </div>
  );
}

export function TransferModal({
  seed,
  onClose,
}: {
  seed?: ModalProdutoSeed;
  onClose: () => void;
}) {
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultPrimary = galpoesList[0];
  const defaultSecondary = galpoesList.find((g) => g.id !== defaultPrimary?.id);

  const [galOrigUser, setGalOrigUser] = useState<string | null>(null);
  const [galDestUser, setGalDestUser] = useState<string | null>(null);
  const [obs, setObs] = useState("");
  const [itens, setItens] = useState<TransferItem[]>(() => [
    { produto: seed?.produto ?? null, qty: "", locOrigem: "" },
  ]);
  const qc = useQueryClient();

  const galOrig = galOrigUser ?? defaultPrimary?.id ?? "";
  const galDest = galDestUser ?? defaultSecondary?.id ?? "";

  // useCallback pra estabilidade — TransferItemRow tem useEffect que depende
  // dessa função; sem useCallback, ela mudaria toda render e o effect rodaria
  // em loop.
  const updateItem = useCallback((idx: number, patch: Partial<TransferItem>) => {
    setItens((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    );
  }, []);
  const addItem = useCallback(() => {
    setItens((prev) => [...prev, { produto: null, qty: "", locOrigem: "" }]);
  }, []);
  const removeItem = useCallback((idx: number) => {
    setItens((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev,
    );
  }, []);

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/transferencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_origem_id: galOrig,
          galpao_destino_id: galDest,
          itens: itens.map((it) => ({
            produto_id: it.produto!.id,
            qty: Number(it.qty),
            localizacao_origem_id: it.locOrigem,
          })),
          observacoes: obs || undefined,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success(
        `Transferência criada com ${itens.length} ite${itens.length > 1 ? "ns" : "m"} — destino precisa receber`,
      );
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
      qc.invalidateQueries({ queryKey: ["wms-transferencias"] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sameGalpao = galOrig === galDest;
  const itensValidos = itens.every(
    (it) => !!it.produto && !!it.locOrigem && Number(it.qty) > 0,
  );
  const valid =
    !!galOrig &&
    !!galDest &&
    !sameGalpao &&
    itens.length > 0 &&
    itensValidos;

  return (
    <Modal
      title="Transferência inter-galpão"
      subtitle="Origem envia; destino confirma a localização ao receber"
      width={840}
      onClose={onClose}
      footer={
        <>
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="wms-btn wms-btn-primary"
            disabled={!valid || mut.isPending}
            onClick={() => mut.mutate()}
          >
            <Icon name="arrow-right" size={11} />
            {mut.isPending
              ? "Enviando…"
              : `Enviar ${itens.length} ite${itens.length > 1 ? "ns" : "m"}`}
          </button>
        </>
      }
    >
      <div className="wms-row-2">
        <Field label="Galpão origem">
          <select
            className="wms-select"
            value={galOrig}
            onChange={(e) => {
              setGalOrigUser(e.target.value);
              setItens((prev) =>
                prev.map((it) => ({ ...it, locOrigem: "" })),
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
        <Field label="Galpão destino">
          <select
            className="wms-select"
            value={galDest}
            onChange={(e) => setGalDestUser(e.target.value)}
          >
            {galpoesList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {sameGalpao && galOrig && galDest && (
        <div className="wms-hint-card wms-hint-danger">
          <Icon name="alert" size={12} />
          <div>Origem e destino estão no mesmo galpão. Use Realocar.</div>
        </div>
      )}

      <div
        className="wms-td-mute"
        style={{ fontSize: 11, marginTop: 14, marginBottom: 6 }}
      >
        <Icon name="alert" size={10} /> Operador do galpão destino vai escolher
        a localização final ao receber.
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 4,
        }}
      >
        {itens.map((it, idx) => (
          <TransferItemRow
            key={idx}
            item={it}
            idx={idx}
            galOrig={galOrig}
            canRemove={itens.length > 1}
            onChange={(patch) => updateItem(idx, patch)}
            onRemove={() => removeItem(idx)}
          />
        ))}
      </div>

      <button
        type="button"
        className="wms-btn wms-btn-ghost wms-btn-sm"
        onClick={addItem}
        style={{ marginTop: 8 }}
      >
        <Icon name="plus" size={11} /> Adicionar item
      </button>

      <Field label="Observação">
        <textarea
          className="wms-textarea"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          placeholder="Ex: rebalanceamento, transferência operacional…"
        />
      </Field>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────
// Realocar intra-galpão (antigo "Replenishment")

interface RealocarSeed {
  produto?: Produto;
  galpao_id?: string;
  localizacao_origem_id?: string;
  localizacao_destino_id?: string;
  qty?: number;
  motivo?: string;
}

interface EstoqueLocLinha {
  saldo: number;
  reservado: number;
  disponivel: number;
  localizacao: { id: string; codigo: string; tipo: string };
  galpao: { id: string };
}

interface EstoqueProdutoView {
  itens: EstoqueLocLinha[];
}

export function RealocarModal({
  seed,
  onClose,
}: {
  seed?: RealocarSeed;
  onClose: () => void;
}) {
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultGalpao = galpoesList[0];

  const [pid, setPid] = useState<Produto | null>(seed?.produto ?? null);
  const [qty, setQty] = useState(seed?.qty ? String(seed.qty) : "");
  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(
    seed?.galpao_id ?? null,
  );
  const [origem, setOrigem] = useState<string>(seed?.localizacao_origem_id ?? "");
  const [destino, setDestino] = useState<string>(
    seed?.localizacao_destino_id ?? "",
  );
  const [obs, setObs] = useState(seed?.motivo ?? "");
  const qc = useQueryClient();

  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";

  // Trocar produto/galpão limpa origem/destino (a menos que seed force).
  useEffect(() => {
    if (!seed?.localizacao_origem_id) setOrigem("");
    if (!seed?.localizacao_destino_id) setDestino("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid?.id, galpaoId]);

  // Estoque do produto: lista de localizações com saldo (origem) e qualquer loc do galpão (destino).
  const estoqueQuery = useQuery({
    queryKey: ["wms-realocar-estoque", pid?.id],
    queryFn: () =>
      wmsApi<{ rows: EstoqueProdutoView[] }>(
        `/api/wms/estoque?view=produto&produto_id=${pid?.id}`,
      ),
    enabled: !!pid?.id,
    staleTime: 30 * 1000,
  });

  const linhasProduto = useMemo(() => {
    const rows = estoqueQuery.data?.rows ?? [];
    const agg = rows[0];
    if (!agg) return [] as EstoqueLocLinha[];
    return agg.itens.filter((l) => !galpaoId || l.galpao.id === galpaoId);
  }, [estoqueQuery.data, galpaoId]);

  const origensDisp = linhasProduto.filter(
    (l) => Number(l.disponivel) > 0,
  );
  const linhaOrig = origensDisp.find((l) => l.localizacao.id === origem);
  const disp = linhaOrig ? Number(linhaOrig.disponivel) : 0;
  const saldoOrigemAtual = linhaOrig ? Number(linhaOrig.saldo) : 0;

  const linhaDest = linhasProduto.find((l) => l.localizacao.id === destino);
  const saldoDestAtual = linhaDest ? Number(linhaDest.saldo) : 0;

  const qn = Number(qty);
  const sameLoc = !!origem && !!destino && origem === destino;
  const valid =
    !!pid &&
    !!galpaoId &&
    !!origem &&
    !!destino &&
    !sameLoc &&
    qn > 0 &&
    qn <= disp;

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/replenishment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_id: galpaoId,
          localizacao_origem_id: origem,
          localizacao_destino_id: destino,
          itens: [{ produto_id: pid!.id, qty: qn }],
          observacoes: obs || undefined,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success(`Realocado: ${fmtNum(qn)} un. de ${pid!.sku}`);
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-ledger"] });
      qc.invalidateQueries({ queryKey: ["wms-produtos"] });
      qc.invalidateQueries({ queryKey: ["wms-realocar-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-produto-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-produto-ledger"] });
      qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Modal
      title="Realocar intra-galpão"
      subtitle="Mover entre localizações no mesmo galpão. Gera par S+E com mesma origem_id."
      width={720}
      onClose={onClose}
      footer={
        <>
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="wms-btn wms-btn-primary"
            disabled={!valid || mut.isPending}
            onClick={() => mut.mutate()}
          >
            <Icon name="shuffle" size={11} />
            {mut.isPending ? "Enviando…" : "Executar realocação"}
          </button>
        </>
      }
    >
      <Field label="Produto" required>
        <ProdutoCombo
          value={pid}
          onChange={setPid}
          autoFocus={!seed?.produto}
        />
      </Field>

      <Field label="Galpão" hint="Realocar é sempre no mesmo galpão">
        <select
          className="wms-select"
          value={galpaoId}
          onChange={(e) => setGalpaoIdUser(e.target.value)}
        >
          {galpoesList.map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
      </Field>

      <div className="wms-trans-grid">
        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill">Origem</span>
          </div>
          <Field
            label="Localização"
            hint={
              linhaOrig
                ? `${fmtNum(disp)} disp.`
                : pid
                  ? "sem saldo neste galpão"
                  : ""
            }
          >
            <select
              className="wms-select"
              value={origem}
              onChange={(e) => setOrigem(e.target.value)}
              disabled={!pid}
            >
              <option value="">— selecionar —</option>
              {origensDisp.map((l) => (
                <option key={l.localizacao.id} value={l.localizacao.id}>
                  {l.localizacao.codigo} ({l.localizacao.tipo}) —{" "}
                  {fmtNum(Number(l.disponivel))} disp.
                </option>
              ))}
            </select>
          </Field>
          {linhaOrig && (
            <div className="wms-repl-preview">
              <div className="wms-repl-preview-row">
                <span className="wms-td-mute">Saldo atual</span>
                <span className="wms-mono">{fmtNum(saldoOrigemAtual)}</span>
              </div>
              <div className="wms-repl-preview-row">
                <span className="wms-td-mute">Após realocar</span>
                <span className="wms-mono wms-td-strong">
                  {fmtNum(saldoOrigemAtual - (qn || 0))}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="wms-trans-arrow">
          <Icon name="arrow-right" size={18} />
          <div className="wms-trans-arrow-qty">
            <input
              className="wms-input"
              type="number"
              min="1"
              max={disp || undefined}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="qty"
            />
          </div>
        </div>

        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill wms-trans-pill-dest">Destino</span>
          </div>
          <Field
            label="Localização"
            hint={linhaDest ? linhaDest.localizacao.tipo : ""}
          >
            <LocalizacaoCombo
              galpaoId={galpaoId || null}
              value={destino}
              onChange={setDestino}
              placeholder="Bipar ou digitar código…"
            />
          </Field>
          {destino && (
            <div className="wms-repl-preview">
              <div className="wms-repl-preview-row">
                <span className="wms-td-mute">Saldo atual</span>
                <span className="wms-mono">{fmtNum(saldoDestAtual)}</span>
              </div>
              <div className="wms-repl-preview-row">
                <span className="wms-td-mute">Após realocar</span>
                <span className="wms-mono wms-td-strong">
                  {fmtNum(saldoDestAtual + (qn || 0))}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {seed?.motivo && (
        <div className="wms-hint-card">
          <Icon name="sparkle" size={12} />
          <div>
            <strong>Sugestão automática</strong>
            <div className="wms-td-mute">{seed.motivo}</div>
          </div>
        </div>
      )}

      {sameLoc && (
        <div className="wms-hint-card wms-hint-danger">
          <Icon name="alert" size={12} />
          <div>Origem e destino são iguais.</div>
        </div>
      )}
      {qn > disp && qty && linhaOrig && (
        <div className="wms-hint-card wms-hint-danger">
          <Icon name="alert" size={12} />
          <div>
            Quantidade maior que o disponível na origem ({fmtNum(disp)}).
          </div>
        </div>
      )}

      <Field label="Observação">
        <textarea
          className="wms-textarea"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          placeholder="Motivo / contexto (gravado no ledger)…"
        />
      </Field>
    </Modal>
  );
}

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
import { calcularAjustes } from "@/lib/wms/ajuste-calc";
import { sisoFetch, useAuth } from "@/lib/auth-context";
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
//
// 3D (2026-05-20): valores precisam estar no CHECK siso_movimentacoes_origem_tipo_check.
// - 'nf_compra' viaja explícito — API exige empresa_compradora_id.
// - 'compra_manual' (compra sem NF) vira 'ajuste_manual' no ledger — entrada
//   manual com motivo, sem documento fiscal.
// - 'devolucao' vira 'devolucao_cliente_integra' — caso comum (avariada tem
//   fluxo dedicado em /wms/devolucoes).
export function origemToBackend(o: ReceberOrigem): string {
  switch (o) {
    case "devolucao":
      return "devolucao_cliente_integra";
    case "nf_compra":
      return "nf_compra";
    case "compra_manual":
    default:
      return "ajuste_manual";
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

type AjusteCategoria =
  | "avaria"
  | "perda"
  | "achado"
  | "correcao_inventario"
  | "devolucao_sem_fluxo"
  | "outro";

// Data de hoje em dd/mm/aaaa (motivo auto do balanço).
function hojeBR(): string {
  const [y, m, d] = hojeISODate().split("-");
  return `${d}/${m}/${y}`;
}

interface NovaLinha {
  key: string;
  localizacao_id: string;
  qty: string;
  custoOpen: boolean;
  custo: string;
}

/**
 * Ajuste de estoque — Modelo A "editar a realidade".
 *
 * Lista as localizações ativas (saldo>0) do produto no galpão com a quantidade
 * editável inline; o operador digita o saldo REAL de cada posição e o sistema
 * calcula o delta (entrada se subiu, saída se desceu) e posta. Balanço fica
 * embutido. "+ nova localização" cobre entrada num lugar novo (custo opcional).
 * Categoria/motivo auto-preenchidos (correcao_inventario / "Balanço dd/mm/aaaa")
 * — confirma em 1 clique, ambos editáveis.
 */
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
  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [novas, setNovas] = useState<NovaLinha[]>([]);
  const [categoria, setCategoria] =
    useState<AjusteCategoria>("correcao_inventario");
  const [motivo, setMotivo] = useState<string>(() => `Balanço ${hojeBR()}`);
  const [erros, setErros] = useState<Record<string, string>>({});
  const novaKey = useRef(0);
  const qc = useQueryClient();

  // Trocar produto/galpão zera a edição (evita aplicar draft de um contexto
  // noutro). Feito nos handlers (não em effect) pra não disparar renders em
  // cascata.
  function resetEdicao() {
    setDrafts({});
    setNovas([]);
    setErros({});
  }

  // view=produto → 1 agregado com itens por tripla (saldo/reservado/disponivel
  // + loc{id,codigo,tipo}). Filtra pelo galpão (siso_estoque é UNIQUE por
  // produto+galpão+loc → 1 item por loc). Mesmo padrão do RealocarModal.
  const estoqueQuery = useQuery({
    queryKey: ["wms-ajuste-locs", pid?.id],
    queryFn: () =>
      wmsApi<{ rows: EstoqueProdutoView[] }>(
        `/api/wms/estoque?view=produto&produto_id=${pid!.id}`,
      ),
    enabled: !!pid?.id,
    staleTime: 15 * 1000,
  });

  const linhas = useMemo<EstoqueLocLinha[]>(() => {
    const agg = estoqueQuery.data?.rows?.[0];
    if (!agg) return [];
    return agg.itens
      .filter((l) => l.galpao.id === galpaoId)
      .sort((a, b) => {
        const ap = a.localizacao.tipo === "picking" ? 0 : 1;
        const bp = b.localizacao.tipo === "picking" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return Number(b.saldo) - Number(a.saldo);
      });
  }, [estoqueQuery.data, galpaoId]);

  const totais = useMemo(
    () =>
      linhas.reduce(
        (a, l) => ({
          saldo: a.saldo + Number(l.saldo),
          reservado: a.reservado + Number(l.reservado),
          disponivel: a.disponivel + Number(l.disponivel),
        }),
        { saldo: 0, reservado: 0, disponivel: 0 },
      ),
    [linhas],
  );

  const { ajustes, erroReserva, erroDuplicada } = useMemo(
    () =>
      calcularAjustes(
        linhas.map((l) => ({
          localizacao_id: l.localizacao.id,
          saldo: Number(l.saldo),
          reservado: Number(l.reservado),
        })),
        drafts,
        novas.map((n) => ({
          localizacao_id: n.localizacao_id,
          qty: n.qty,
          custo: n.custo,
        })),
      ),
    [linhas, drafts, novas],
  );

  const temMudanca = ajustes.length > 0;
  const valid =
    !!pid &&
    !!galpaoId &&
    temMudanca &&
    !erroReserva &&
    !erroDuplicada &&
    motivo.trim().length >= 3;

  const mut = useMutation({
    mutationFn: async () => {
      // Sequencial: movs de ajuste são independentes no ledger; falha parcial
      // deixa estado consistente (as aplicadas estão certas) e recuperável.
      const results: { localizacao_id: string; ok: boolean; msg?: string }[] =
        [];
      for (const a of ajustes) {
        try {
          const r = await sisoFetch("/api/wms/ajuste", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tripla: {
                produto_id: pid!.id,
                galpao_id: galpaoId,
                localizacao_id: a.localizacao_id,
              },
              qty: a.qty,
              direcao: a.direcao,
              motivo: motivo.trim(),
              motivo_categoria: categoria,
              ...(a.direcao === "entrada" && a.custo_unitario != null
                ? { custo_unitario: a.custo_unitario }
                : {}),
            }),
          });
          if (!r.ok) {
            const b = (await r.json().catch(() => ({}))) as { error?: string };
            results.push({
              localizacao_id: a.localizacao_id,
              ok: false,
              msg: b.error || `HTTP ${r.status}`,
            });
          } else {
            results.push({ localizacao_id: a.localizacao_id, ok: true });
          }
        } catch (e) {
          results.push({
            localizacao_id: a.localizacao_id,
            ok: false,
            msg: (e as Error).message,
          });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const okIds = new Set(
        results.filter((r) => r.ok).map((r) => r.localizacao_id),
      );
      const falhas = results.filter((r) => !r.ok);

      // Parte do estoque mudou mesmo em falha parcial → invalida tudo.
      for (const key of [
        "wms-estoque",
        "wms-ledger",
        "wms-produtos",
        "wms-cobertura",
        "wms-cobertura-all",
        "wms-dashboard-geral",
        "wms-produto",
        "wms-produto-estoque",
        "wms-produto-ledger",
        "wms-produto-cobertura",
        "wms-ajuste-locs",
      ]) {
        qc.invalidateQueries({ queryKey: [key] });
      }

      if (falhas.length === 0) {
        const n = results.length;
        toast.success(
          `${n} ajuste${n === 1 ? "" : "s"} aplicado${n === 1 ? "" : "s"}`,
        );
        onClose();
        return;
      }

      toast.warning(
        `${okIds.size} de ${results.length} aplicados — ${falhas.length} falhou${falhas.length === 1 ? "" : "ram"}`,
      );
      // Limpa as que aplicaram (o refetch traz o saldo novo → delta zera); mantém
      // as falhas com o erro inline.
      setDrafts((d) => {
        const next = { ...d };
        for (const id of okIds) delete next[id];
        return next;
      });
      setNovas((ns) => ns.filter((n) => !okIds.has(n.localizacao_id)));
      setErros(
        Object.fromEntries(
          falhas.map((f) => [f.localizacao_id, f.msg ?? "falhou"]),
        ),
      );
      estoqueQuery.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function clearErro(locId: string) {
    setErros((e) => {
      if (!e[locId]) return e;
      const next = { ...e };
      delete next[locId];
      return next;
    });
  }
  function bump(locId: string, saldo: number, n: number) {
    clearErro(locId);
    setDrafts((d) => {
      const raw = d[locId];
      const base = raw !== undefined && raw.trim() !== "" ? Number(raw) : saldo;
      return { ...d, [locId]: String(Math.max(0, base + n)) };
    });
  }
  function setDraft(locId: string, value: string) {
    clearErro(locId);
    setDrafts((d) => ({ ...d, [locId]: value }));
  }
  const addNova = () =>
    setNovas((ns) => [
      ...ns,
      {
        key: `n${novaKey.current++}`,
        localizacao_id: "",
        qty: "",
        custoOpen: false,
        custo: "",
      },
    ]);
  const updateNova = (key: string, patch: Partial<NovaLinha>) =>
    setNovas((ns) => ns.map((n) => (n.key === key ? { ...n, ...patch } : n)));
  const removeNova = (key: string) =>
    setNovas((ns) => ns.filter((n) => n.key !== key));

  return (
    <Modal
      title="Ajuste de estoque"
      subtitle="Balanço por localização — edite o saldo real de cada posição (sem NF)."
      onClose={onClose}
      width={720}
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
            <Icon name="check" size={11} />
            {mut.isPending
              ? "Aplicando…"
              : ajustes.length > 0
                ? `Confirmar ${ajustes.length} ajuste${ajustes.length === 1 ? "" : "s"}`
                : "Confirmar ajuste"}
          </button>
        </>
      }
    >
      <Field label="Produto" required>
        <ProdutoCombo
          value={pid}
          onChange={(p) => {
            setPid(p);
            resetEdicao();
          }}
          autoFocus={!seed?.produto}
        />
      </Field>

      <Field label="Galpão">
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <select
            className="wms-select"
            style={{ width: 200 }}
            value={galpaoId}
            onChange={(e) => {
              setGalpaoIdUser(e.target.value);
              resetEdicao();
            }}
          >
            {galpoesList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nome}
              </option>
            ))}
          </select>
          {!!pid && linhas.length > 0 && (
            <div style={{ display: "flex", gap: 16 }}>
              {(
                [
                  ["saldo físico", totais.saldo, "var(--wms-c-fg)"],
                  ["reservado", totais.reservado, "var(--wms-c-warn)"],
                  ["disponível", totais.disponivel, "var(--wms-c-ok)"],
                ] as const
              ).map(([lbl, val, color]) => (
                <div key={lbl}>
                  <div
                    className="wms-mono"
                    style={{
                      fontSize: 17,
                      fontWeight: 700,
                      lineHeight: 1.1,
                      color,
                    }}
                  >
                    {fmtNum(val)}
                  </div>
                  <div className="wms-td-mute" style={{ fontSize: 10.5 }}>
                    {lbl}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Field>

      {!!pid && (
        <Field
          label="Localizações ativas"
          hint="edite p/ bater com a contagem real"
        >
          <div
            style={{
              border: "1px solid var(--wms-c-border)",
              borderRadius: "var(--wms-r-3)",
              overflow: "hidden",
            }}
          >
            {estoqueQuery.isLoading && (
              <div className="wms-td-mute" style={{ padding: 12, fontSize: 12 }}>
                carregando…
              </div>
            )}
            {!estoqueQuery.isLoading && linhas.length === 0 && (
              <div className="wms-td-mute" style={{ padding: 12, fontSize: 12 }}>
                Nenhum saldo neste galpão — use “+ adicionar em nova
                localização” para registrar entrada.
              </div>
            )}
            {linhas.map((l) => {
              const locId = l.localizacao.id;
              const saldo = Number(l.saldo);
              const reservado = Number(l.reservado);
              const raw = drafts[locId];
              const hasVal = raw !== undefined && raw.trim() !== "";
              const inputVal = raw ?? String(saldo);
              const real = hasVal ? Number(raw) : saldo;
              const delta = hasVal ? real - saldo : 0;
              const below = hasVal && real < reservado;
              const erro = erros[locId];
              return (
                <div
                  key={locId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderTop: "1px solid var(--wms-c-border)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="wms-mono" style={{ fontWeight: 600 }}>
                      {l.localizacao.codigo}
                    </span>
                    <div className="wms-td-mute" style={{ fontSize: 11 }}>
                      {l.localizacao.tipo} · sistema: {fmtNum(saldo)} un
                      {reservado > 0 ? ` · ${fmtNum(reservado)} reserv.` : ""}
                    </div>
                    {(below || erro) && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--wms-c-danger)",
                          marginTop: 3,
                        }}
                      >
                        <Icon name="alert" size={10} />{" "}
                        {below
                          ? `real ${fmtNum(real)} < ${fmtNum(reservado)} reservados`
                          : erro}
                      </div>
                    )}
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 2 }}
                  >
                    <button
                      type="button"
                      className="wms-btn-icon wms-btn-sm"
                      onClick={() => bump(locId, saldo, 1)}
                      aria-label="mais um"
                    >
                      <Icon name="chevron-u" size={11} />
                    </button>
                    <button
                      type="button"
                      className="wms-btn-icon wms-btn-sm"
                      onClick={() => bump(locId, saldo, -1)}
                      aria-label="menos um"
                    >
                      <Icon name="chevron-d" size={11} />
                    </button>
                  </div>
                  <input
                    className="wms-input"
                    type="number"
                    min="0"
                    value={inputVal}
                    onChange={(e) => setDraft(locId, e.target.value)}
                    style={{
                      width: 78,
                      textAlign: "center",
                      fontWeight: 600,
                      ...(below || erro
                        ? { borderColor: "var(--wms-c-danger)" }
                        : delta !== 0
                          ? { borderColor: "var(--wms-c-ok)" }
                          : {}),
                    }}
                  />
                  <span
                    className="wms-mono"
                    style={{
                      width: 52,
                      textAlign: "right",
                      fontSize: 12.5,
                      fontWeight: 700,
                      color:
                        delta > 0
                          ? "var(--wms-c-ok)"
                          : delta < 0
                            ? "var(--wms-c-danger)"
                            : "var(--wms-c-mute)",
                    }}
                  >
                    {delta > 0
                      ? `+${fmtNum(delta)}`
                      : delta < 0
                        ? fmtNum(delta)
                        : "—"}
                  </span>
                </div>
              );
            })}

            {novas.map((n) => {
              const dup =
                !!n.localizacao_id &&
                (linhas.some((l) => l.localizacao.id === n.localizacao_id) ||
                  novas.some(
                    (x) =>
                      x.key !== n.key && x.localizacao_id === n.localizacao_id,
                  ));
              return (
                <div
                  key={n.key}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 12px",
                    borderTop: "1px solid var(--wms-c-border)",
                    background: "var(--wms-c-faint)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <LocalizacaoCombo
                      galpaoId={galpaoId}
                      value={n.localizacao_id}
                      onChange={(v) => updateNova(n.key, { localizacao_id: v })}
                      allowCreate
                      placeholder="Bipar ou criar localização…"
                    />
                    {dup && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--wms-c-danger)",
                          marginTop: 3,
                        }}
                      >
                        <Icon name="alert" size={10} /> essa loc já está na lista
                        acima
                      </div>
                    )}
                    {n.custoOpen ? (
                      <input
                        className="wms-input"
                        type="number"
                        min="0"
                        step="0.01"
                        value={n.custo}
                        onChange={(e) =>
                          updateNova(n.key, { custo: e.target.value })
                        }
                        placeholder="custo unitário (R$)"
                        style={{ marginTop: 6, maxWidth: 200 }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => updateNova(n.key, { custoOpen: true })}
                        style={{
                          marginTop: 5,
                          fontSize: 11.5,
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          color: "var(--wms-c-mute)",
                        }}
                      >
                        <Icon name="plus" size={9} /> informar custo unitário
                      </button>
                    )}
                  </div>
                  <input
                    className="wms-input"
                    type="number"
                    min="0"
                    value={n.qty}
                    onChange={(e) => updateNova(n.key, { qty: e.target.value })}
                    placeholder="qty"
                    style={{ width: 78, textAlign: "center", fontWeight: 600 }}
                  />
                  <button
                    type="button"
                    className="wms-btn-icon"
                    onClick={() => removeNova(n.key)}
                    aria-label="remover linha"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              className="wms-btn wms-btn-ghost wms-btn-sm"
              onClick={addNova}
              style={{
                width: "100%",
                borderRadius: 0,
                borderTop: "1px solid var(--wms-c-border)",
                justifyContent: "center",
              }}
            >
              <Icon name="plus" size={11} /> adicionar em nova localização
            </button>
          </div>
        </Field>
      )}

      {temMudanca && (
        <div className="wms-row-2">
          <Field label="Categoria">
            <select
              className="wms-select"
              value={categoria}
              onChange={(e) => setCategoria(e.target.value as AjusteCategoria)}
            >
              <option value="correcao_inventario">Correção de inventário</option>
              <option value="avaria">Avaria</option>
              <option value="perda">Perda</option>
              <option value="achado">Achado</option>
              <option value="devolucao_sem_fluxo">Devolução sem fluxo</option>
              <option value="outro">Outro</option>
            </select>
          </Field>
          <Field label="Motivo" hint="vai pro ledger">
            <input
              className="wms-input"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex: Balanço, avaria em manuseio…"
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────
// Transferência inter-galpão

interface TransferLocSel {
  localizacao_id: string;
  qty: string;
}

interface TransferItem {
  produto: Produto | null;
  /** Locs origem (1+) — qty é split por loc; total = sum(locs.qty). */
  locs: TransferLocSel[];
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

  // Auto-seleciona a primeira loc (maior saldo em picking) com qty = saldo
  // quando o produto muda e ainda não há nenhuma loc escolhida.
  // onChange é estável (useCallback no parent).
  useEffect(() => {
    if (item.produto && item.locs.length === 0 && locais.length > 0) {
      onChange({
        locs: [
          {
            localizacao_id: locais[0].localizacao_id,
            qty: String(Number(locais[0].saldo)),
          },
        ],
      });
    }
  }, [item.produto, item.locs.length, locais, onChange]);

  const totalQty = item.locs.reduce(
    (s, l) => s + (Number(l.qty) || 0),
    0,
  );
  const locsComErro = item.locs.filter((l) => {
    const sl = locais.find((x) => x.localizacao_id === l.localizacao_id);
    return !!sl && Number(l.qty) > Number(sl.saldo);
  });

  function toggleLoc(l: LocalSaldo) {
    const existsIdx = item.locs.findIndex(
      (s) => s.localizacao_id === l.localizacao_id,
    );
    if (existsIdx >= 0) {
      onChange({ locs: item.locs.filter((_, i) => i !== existsIdx) });
    } else {
      onChange({
        locs: [
          ...item.locs,
          {
            localizacao_id: l.localizacao_id,
            qty: String(Number(l.saldo)),
          },
        ],
      });
    }
  }

  function updateLocQty(locId: string, qty: string) {
    onChange({
      locs: item.locs.map((l) =>
        l.localizacao_id === locId ? { ...l, qty } : l,
      ),
    });
  }

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
          gridTemplateColumns: "1fr auto 32px",
          gap: 12,
          alignItems: "end",
        }}
      >
        <Field label={idx === 0 ? "Produto" : undefined} required>
          <ProdutoCombo
            value={item.produto}
            onChange={(p) => onChange({ produto: p, locs: [] })}
          />
        </Field>
        <div style={{ marginBottom: 6, textAlign: "right", minWidth: 110 }}>
          {item.locs.length > 0 ? (
            <>
              <div
                className="wms-td-mute"
                style={{ fontSize: 10.5, lineHeight: 1 }}
              >
                Total a transferir
              </div>
              <div
                className="wms-mono"
                style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}
              >
                {fmtNum(totalQty)} un
              </div>
              {item.locs.length > 1 && (
                <div
                  className="wms-td-mute"
                  style={{ fontSize: 10.5, lineHeight: 1 }}
                >
                  {item.locs.length} locs
                </div>
              )}
            </>
          ) : (
            ready && (
              <div
                className="wms-td-mute"
                style={{ fontSize: 11, lineHeight: 1.2 }}
              >
                Clique 1+ locs abaixo
              </div>
            )
          )}
        </div>
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
            <Icon name="box" size={10} /> Onde tem saldo · clique pra
            selecionar (pode escolher mais de uma):
          </span>
          {locais.map((l) => {
            const sel = item.locs.find(
              (s) => s.localizacao_id === l.localizacao_id,
            );
            if (sel) {
              const qn = Number(sel.qty);
              const over = qn > Number(l.saldo);
              return (
                <div
                  key={l.localizacao_id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 4px 4px 8px",
                    background: "var(--wms-c-fg)",
                    color: "var(--wms-c-bg)",
                    border: "1px solid var(--wms-c-fg)",
                    borderRadius: "var(--wms-r-2)",
                    fontSize: 11,
                  }}
                >
                  <span className="wms-mono">{l.codigo}</span>
                  <span style={{ opacity: 0.7, fontSize: 10.5 }}>
                    {l.tipo}
                  </span>
                  <input
                    type="number"
                    min="1"
                    max={l.saldo}
                    value={sel.qty}
                    onChange={(e) =>
                      updateLocQty(l.localizacao_id, e.target.value)
                    }
                    onClick={(e) => e.stopPropagation()}
                    className="wms-mono wms-tar"
                    style={{
                      width: 52,
                      padding: "2px 4px",
                      fontSize: 12,
                      borderRadius: "var(--wms-r-1)",
                      border: over
                        ? "1px solid #f87171"
                        : "1px solid rgba(255,255,255,0.25)",
                      background: over
                        ? "#dc2626"
                        : "rgba(255,255,255,0.12)",
                      color: "var(--wms-c-bg)",
                    }}
                  />
                  <span style={{ opacity: 0.7, fontSize: 10.5 }}>
                    / {fmtNum(Number(l.saldo))}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleLoc(l)}
                    title="Remover esta loc"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      border: "none",
                      background: "transparent",
                      color: "var(--wms-c-bg)",
                      opacity: 0.8,
                      cursor: "pointer",
                      borderRadius: "var(--wms-r-1)",
                    }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              );
            }
            return (
              <button
                key={l.localizacao_id}
                type="button"
                onClick={() => toggleLoc(l)}
                className="wms-btn wms-btn-sm wms-btn-ghost"
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
      {locsComErro.length > 0 && (
        <div className="wms-td-warn" style={{ fontSize: 11, marginTop: 6 }}>
          <Icon name="alert" size={10} /> Qty maior que saldo em{" "}
          {locsComErro.length === 1
            ? "1 localização"
            : `${locsComErro.length} localizações`}
          .
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
    { produto: seed?.produto ?? null, locs: [] },
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
    setItens((prev) => [...prev, { produto: null, locs: [] }]);
  }, []);
  const removeItem = useCallback((idx: number) => {
    setItens((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev,
    );
  }, []);

  // Cada item × cada loc origem vira uma entrada no payload. A API
  // aceita várias entradas com o mesmo produto_id (uma por loc origem).
  const payloadItens = useMemo(
    () =>
      itens.flatMap((it) =>
        it.produto
          ? it.locs.map((l) => ({
              produto_id: it.produto!.id,
              qty: Number(l.qty),
              localizacao_origem_id: l.localizacao_id,
            }))
          : [],
      ),
    [itens],
  );

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/transferencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          galpao_origem_id: galOrig,
          galpao_destino_id: galDest,
          itens: payloadItens,
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
    (it) =>
      !!it.produto &&
      it.locs.length > 0 &&
      it.locs.every((l) => Number(l.qty) > 0),
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
              setItens((prev) => prev.map((it) => ({ ...it, locs: [] })));
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
            {/* Replenishment: allowCreate=true preserved — operador às vezes cria
                loc nova de destino legitimamente quando expande galpão. */}
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

// ──────────────────────────────────────────────────────────────────
// Etiquetas de produto (imprime via /api/wms/guarda/imprimir-lote modo linhas)

export function EtiquetasModal({
  seed,
  onClose,
}: {
  seed?: ModalProdutoSeed;
  onClose: () => void;
}) {
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const { activeGalpaoId } = useAuth();

  const [pid, setPid] = useState<Produto | null>(seed?.produto ?? null);
  const [qty, setQty] = useState("1");
  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const [locIdUser, setLocIdUser] = useState<string | null>(null);

  // Galpão decide a impressora: escolha manual > galpão ativo da sidebar > 1º.
  const galpaoId =
    galpaoIdUser ??
    (activeGalpaoId && galpoesList.some((g) => g.id === activeGalpaoId)
      ? activeGalpaoId
      : (galpoesList[0]?.id ?? ""));

  // Locs com saldo do produto no galpão — a loc impressa orienta a guarda.
  // Reusa o endpoint do receber (picking primeiro, saldo desc).
  const locaisQuery = useQuery({
    queryKey: ["wms-putaway", pid?.id, galpaoId],
    queryFn: () =>
      wmsApi<{ locaisExistentes: LocalSaldo[] }>(
        `/api/wms/receber?produto_id=${pid!.id}&galpao_id=${galpaoId}`,
      ),
    enabled: !!pid && !!galpaoId,
    staleTime: 30 * 1000,
  });
  const locaisDisp = locaisQuery.data?.locaisExistentes ?? [];
  const locId = locIdUser ?? locaisDisp[0]?.localizacao_id ?? "";

  const qtyNum = Number(qty);
  const folhas = qtyNum > 0 ? Math.ceil(qtyNum / 2) : 0;

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/guarda/imprimir-lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linhas: [
            {
              produto_id: pid!.id,
              galpao_id: galpaoId,
              qty: qtyNum,
              ...(locId ? { localizacao_id: locId } : {}),
            },
          ],
        }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        totalEtiquetas?: number;
        totalFolhas?: number;
        fallbackEnvelope?: boolean;
      };
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      return body;
    },
    onSuccess: (body) => {
      toast.success(
        `${fmtNum(body.totalEtiquetas ?? qtyNum)} etiquetas (${fmtNum(
          body.totalFolhas ?? folhas,
        )} folhas) enviadas pra impressão`,
      );
      if (body.fallbackEnvelope) {
        toast.warning(
          "Impressora de produto não configurada — usando a de envio",
        );
      }
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const valid =
    !!pid && !!galpaoId && Number.isInteger(qtyNum) && qtyNum > 0;

  return (
    <Modal
      title="Imprimir etiquetas de produto"
      subtitle="1 etiqueta por unidade, 2 por folha. Vai pra impressora de produto do galpão."
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
            <Icon name="printer" size={11} />
            {mut.isPending
              ? "Enviando…"
              : `Imprimir${qtyNum > 0 ? ` ${fmtNum(qtyNum)}` : ""}`}
          </button>
        </>
      }
    >
      <Field label="Produto" required>
        <ProdutoCombo
          value={pid}
          onChange={(p) => {
            setPid(p);
            setLocIdUser(null);
          }}
          autoFocus={!seed?.produto}
        />
      </Field>

      <div className="wms-row-2">
        <Field label="Galpão (impressora)">
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
        <Field
          label="Quantidade"
          required
          hint={folhas > 0 ? `${fmtNum(folhas)} folha${folhas > 1 ? "s" : ""}` : undefined}
        >
          <input
            className="wms-input"
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
            autoFocus={!!seed?.produto}
          />
        </Field>
      </div>

      {!!pid && !!galpaoId && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: -4,
            marginBottom: 4,
          }}
        >
          <span
            className="wms-td-mute"
            style={{ fontSize: 11, alignSelf: "center", marginRight: 2 }}
          >
            <Icon name="pin" size={10} /> Loc na etiqueta:
          </span>
          {locaisQuery.isLoading && (
            <span
              className="wms-td-mute"
              style={{ fontSize: 11, alignSelf: "center" }}
            >
              carregando…
            </span>
          )}
          {!locaisQuery.isLoading && locaisDisp.length === 0 && (
            <span
              className="wms-td-mute"
              style={{ fontSize: 11, alignSelf: "center" }}
            >
              sem saldo nesse galpão — etiqueta sai sem loc
            </span>
          )}
          {locaisDisp.map((l) => {
            const isSelected = l.localizacao_id === locId;
            return (
              <button
                key={l.localizacao_id}
                type="button"
                onClick={() => setLocIdUser(l.localizacao_id)}
                className={`wms-btn wms-btn-sm ${
                  isSelected ? "wms-btn-primary" : "wms-btn-ghost"
                }`}
                style={{ fontSize: 11 }}
              >
                <span className="wms-mono">{l.codigo}</span>
                <span style={{ marginLeft: 5, fontSize: 10.5 }}>
                  {fmtNum(Number(l.saldo))} un
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

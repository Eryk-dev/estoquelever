"use client";

import { useMemo, useState } from "react";
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
      const r = await sisoFetch("/api/admin/galpoes");
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
}: {
  value: Produto | null;
  onChange: (p: Produto | null) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useAutoFocus<HTMLInputElement>(autoFocus && !value);
  const { data, isFetching } = useProdutoSearch(q);
  const opts = data?.rows ?? [];

  if (value && !open) {
    return (
      <div className="wms-picker">
        <div className="wms-picker-selected">
          <div>
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
// Localização select

export function LocalizacaoSelect({
  galpaoId,
  value,
  onChange,
  allowedTipos,
}: {
  galpaoId: string | null;
  value: string;
  onChange: (id: string) => void;
  allowedTipos?: TipoLocalizacao[];
}) {
  const { data } = useLocalizacoes(galpaoId);
  const opts = (data?.rows ?? []).filter(
    (l) => l.ativo && (!allowedTipos || allowedTipos.includes(l.tipo)),
  );

  return (
    <select
      className="wms-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">— selecionar —</option>
      {opts.map((l) => (
        <option key={l.id} value={l.id}>
          {l.codigo} ({l.tipo})
          {l.descricao ? ` — ${l.descricao}` : ""}
        </option>
      ))}
    </select>
  );
}

// ──────────────────────────────────────────────────────────────────
// Receber

interface ModalProdutoSeed {
  produto?: Produto;
}

type ReceberOrigem =
  | "compra_manual"
  | "nf_compra"
  | "devolucao"
  | "transferencia"
  | "retroativo";

const RECEBER_ORIGEM_OPTS: { id: ReceberOrigem; label: string }[] = [
  { id: "compra_manual", label: "Compra manual" },
  { id: "nf_compra", label: "NF de compra" },
  { id: "devolucao", label: "Devolução" },
  { id: "transferencia", label: "Transferência" },
  { id: "retroativo", label: "Retroativo" },
];

export function ReceberModal({
  seed,
  onClose,
}: {
  seed?: ModalProdutoSeed;
  onClose: () => void;
}) {
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultGalpao = galpoesList.find((g) => g.empresas.length > 0);

  const [pid, setPid] = useState<Produto | null>(seed?.produto ?? null);
  const [qty, setQty] = useState("");
  const [custo, setCusto] = useState("");
  const [origem, setOrigem] = useState<ReceberOrigem>("compra_manual");
  const [empresaIdUser, setEmpresaIdUser] = useState<string | null>(null);
  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const [locIdUser, setLocIdUser] = useState<string | null>(null);
  const [obs, setObs] = useState("");
  const qc = useQueryClient();

  // Valores efetivos: user choice ?? padrão derivado dos dados
  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";
  const galpao = galpoesList.find((g) => g.id === galpaoId);
  const empresasGalpao = galpao?.empresas ?? [];
  const empresaId = empresaIdUser ?? empresasGalpao[0]?.id ?? "";

  // Sugestão de putaway
  const sugQuery = useQuery({
    queryKey: ["wms-putaway", pid?.id, empresaId, galpaoId],
    queryFn: () =>
      wmsApi<{
        localizacao_id: string;
        codigo?: string;
        razao: string;
      } | null>(
        `/api/wms/receber?produto_id=${pid?.id}&empresa_id=${empresaId}&galpao_id=${galpaoId}`,
      ),
    enabled: !!(pid?.id && empresaId && galpaoId),
    staleTime: 30 * 1000,
  });

  const locId = locIdUser ?? sugQuery.data?.localizacao_id ?? "";

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/receber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_dona_id: empresaId,
          galpao_id: galpaoId,
          itens: [
            {
              produto_id: pid!.id,
              qty: Number(qty),
              custo_unitario: custo ? Number(custo) : undefined,
              localizacao_id: locId,
            },
          ],
          origem_tipo: origem,
          observacoes: obs || undefined,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
    },
    onSuccess: () => {
      toast.success(`Entrada registrada: +${fmtNum(Number(qty))} de ${pid!.sku}`);
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-ledger"] });
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const valid =
    !!pid && !!empresaId && !!galpaoId && !!locId && Number(qty) > 0;

  return (
    <Modal
      title="Receber mercadoria"
      subtitle="Entrada no ledger com sugestão automática de putaway"
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
            <Icon name="check" size={11} />
            {mut.isPending ? "Enviando…" : "Confirmar entrada"}
          </button>
        </>
      }
    >
      <Field label="Produto" required>
        <ProdutoCombo value={pid} onChange={setPid} autoFocus={!seed?.produto} />
      </Field>

      <div className="wms-row-2">
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
        <Field
          label="Custo unitário"
          hint="Recalcula custo médio se informado"
        >
          <div className="wms-input-prefix">
            <span>R$</span>
            <input
              type="number"
              step="0.01"
              value={custo}
              onChange={(e) => setCusto(e.target.value)}
              placeholder="0,00"
            />
          </div>
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

      <div className="wms-row-3">
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
        <Field label="Galpão">
          <select
            className="wms-select"
            value={galpaoId}
            onChange={(e) => {
              setGalpaoIdUser(e.target.value);
              setEmpresaIdUser(null);
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
          <LocalizacaoSelect
            galpaoId={galpaoId}
            value={locId}
            onChange={(v) => setLocIdUser(v)}
          />
        </Field>
      </div>

      {sugQuery.data?.localizacao_id && locId === sugQuery.data.localizacao_id && (
        <div className="wms-hint-card">
          <Icon name="sparkle" size={12} />
          <div>
            <div>
              <strong>Sugestão de putaway:</strong>{" "}
              <span className="wms-mono">
                {sugQuery.data.codigo ?? sugQuery.data.localizacao_id}
              </span>
            </div>
            <div className="wms-td-mute">{sugQuery.data.razao}</div>
          </div>
        </div>
      )}

      <Field label="Observação">
        <textarea
          className="wms-textarea"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          placeholder="NF, lote, observações de recebimento…"
        />
      </Field>
    </Modal>
  );
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
  const defaultGalpao = galpoesList.find((g) => g.empresas.length > 0);

  const [pid, setPid] = useState<Produto | null>(seed?.produto ?? null);
  const [qty, setQty] = useState("");
  const [direcao, setDirecao] = useState<"entrada" | "saida">("saida");
  const [motivo, setMotivo] = useState("");
  const [empresaIdUser, setEmpresaIdUser] = useState<string | null>(null);
  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  const [locIdUser, setLocIdUser] = useState<string | null>(null);
  const qc = useQueryClient();

  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";
  const galpao = galpoesList.find((g) => g.id === galpaoId);
  const empresasGalpao = galpao?.empresas ?? [];
  const empresaId = empresaIdUser ?? empresasGalpao[0]?.id ?? "";
  const locId = locIdUser ?? "";

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/ajuste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quadrupla: {
            produto_id: pid!.id,
            empresa_dona_id: empresaId,
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
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const valid =
    !!pid &&
    !!empresaId &&
    !!galpaoId &&
    !!locId &&
    Number(qty) > 0 &&
    motivo.trim().length >= 3;

  return (
    <Modal
      title="Ajuste de estoque"
      subtitle="Entrada ou saída avulsa, sem NF. Motivo obrigatório."
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

      <div className="wms-row-3">
        <Field label="Galpão">
          <select
            className="wms-select"
            value={galpaoId}
            onChange={(e) => {
              setGalpaoIdUser(e.target.value);
              setEmpresaIdUser(null);
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
        <Field label="Localização" required>
          <LocalizacaoSelect
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

export function TransferModal({
  seed,
  onClose,
}: {
  seed?: ModalProdutoSeed;
  onClose: () => void;
}) {
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultPrimary = galpoesList.find((g) => g.empresas.length > 0);
  const defaultSecondary = galpoesList.find(
    (g) => g.id !== defaultPrimary?.id && g.empresas.length > 0,
  );

  const [pid, setPid] = useState<Produto | null>(seed?.produto ?? null);
  const [qty, setQty] = useState("");
  const [empresaIdUser, setEmpresaIdUser] = useState<string | null>(null);
  const [galOrigUser, setGalOrigUser] = useState<string | null>(null);
  const [locOrig, setLocOrig] = useState("");
  const [galDestUser, setGalDestUser] = useState<string | null>(null);
  const [locDest, setLocDest] = useState("");
  const [obs, setObs] = useState("");
  const qc = useQueryClient();

  const galOrig = galOrigUser ?? defaultPrimary?.id ?? "";
  const galDest = galDestUser ?? defaultSecondary?.id ?? "";

  const empresasOrig = useMemo(
    () => galpoesList.find((g) => g.id === galOrig)?.empresas ?? [],
    [galpoesList, galOrig],
  );
  const empresaId = empresaIdUser ?? empresasOrig[0]?.id ?? "";

  const mut = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/transferir-galpao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_id: empresaId,
          galpao_origem_id: galOrig,
          localizacao_origem_id: locOrig,
          galpao_destino_id: galDest,
          localizacao_destino_id: locDest,
          itens: [{ produto_id: pid!.id, qty: Number(qty) }],
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
        `Transferência registrada: ${fmtNum(Number(qty))} un. de ${pid!.sku}`,
      );
      qc.invalidateQueries({ queryKey: ["wms-estoque"] });
      qc.invalidateQueries({ queryKey: ["wms-ledger"] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sameGalpao = galOrig === galDest;
  const valid =
    !!pid &&
    !!empresaId &&
    !!galOrig &&
    !!galDest &&
    !sameGalpao &&
    !!locOrig &&
    !!locDest &&
    Number(qty) > 0;

  return (
    <Modal
      title="Transferência inter-galpão"
      subtitle="Gera par S+E com mesma origem_id"
      width={680}
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
            {mut.isPending ? "Enviando…" : "Confirmar transferência"}
          </button>
        </>
      }
    >
      <Field label="Produto" required>
        <ProdutoCombo value={pid} onChange={setPid} autoFocus={!seed?.produto} />
      </Field>

      <Field label="Empresa (dona)">
        <select
          className="wms-select"
          value={empresaId}
          onChange={(e) => setEmpresaIdUser(e.target.value)}
        >
          {empresasOrig.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
      </Field>

      <div className="wms-trans-grid">
        <div className="wms-trans-side">
          <div className="wms-trans-side-h">
            <span className="wms-trans-pill">Origem</span>
          </div>
          <Field label="Galpão">
            <select
              className="wms-select"
              value={galOrig}
              onChange={(e) => {
                setGalOrigUser(e.target.value);
                setEmpresaIdUser(null);
                setLocOrig("");
              }}
            >
              {galpoesList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Localização">
            <LocalizacaoSelect
              galpaoId={galOrig || null}
              value={locOrig}
              onChange={setLocOrig}
            />
          </Field>
        </div>

        <div className="wms-trans-arrow">
          <Icon name="arrow-right" size={18} />
          <div className="wms-trans-arrow-qty">
            <input
              className="wms-input"
              type="number"
              min="1"
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
          <Field label="Galpão">
            <select
              className="wms-select"
              value={galDest}
              onChange={(e) => {
                setGalDestUser(e.target.value);
                setLocDest("");
              }}
            >
              {galpoesList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Localização">
            <LocalizacaoSelect
              galpaoId={galDest || null}
              value={locDest}
              onChange={setLocDest}
            />
          </Field>
        </div>
      </div>

      <Field label="Observação">
        <textarea
          className="wms-textarea"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          placeholder="Ex: rebalanceamento, transferência operacional…"
        />
      </Field>

      {sameGalpao && galOrig && galDest && (
        <div className="wms-hint-card wms-hint-danger">
          <Icon name="alert" size={12} />
          <div>Origem e destino estão no mesmo galpão. Use replenishment.</div>
        </div>
      )}
    </Modal>
  );
}

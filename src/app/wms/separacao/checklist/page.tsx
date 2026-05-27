"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  PageHeader,
  Icon,
  fmtNum,
} from "@/components/wms/ui/wms-ui";
import { HandheldScan } from "@/components/wms/vendas/handheld-scan";
import { useAuth, sisoFetch } from "@/lib/auth-context";
import { naturalLocCompare } from "@/lib/domain-helpers";
import { ParcialModal } from "@/components/wms/separacao/parcial-modal";
import { useRealtimeSeparacao } from "@/hooks/use-realtime-separacao";
import { useTrackPresencaWms } from "@/hooks/use-presenca-wms";

// ──────────────────────────────────────────────────────────────────
// Types

// Plano ledger simplificado 3D (2026-05-20): pool fungível por (produto, galpão).
// API não devolve mais empresa_dona/devedora/is_emprestimo — Realocação aponta só pra loc.
interface Realocacao {
  id: string;
  parent_realocacao_id: string | null;
  localizacao_id: string;
  localizacao_codigo: string;
  quantidade: number;
  quantidade_pega: number | null;
  parcial: boolean;
  parcial_motivo: string | null;
  status: "aguardando_picking" | "picado" | "picado_parcial" | "cancelado";
  criado_em: string;
}

interface ChecklistItem {
  id: string;
  pedido_id: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  quantidade: number;
  separacao_marcado: boolean;
  separacao_marcado_em: string | null;
  localizacao: string | null;
  imagem_url: string | null;
  empresa_origem_id: string | null;
  saldo: number;
  disponivel: number;
  galpao_nome: string | null;
  compra_status:
    | "oc_pendente"
    | "aguardando_compra"
    | "comprado"
    | "recebido"
    | "indisponivel"
    | "equivalente_pendente"
    | "cancelamento_pendente"
    | "cancelado"
    | null;
  // Parcial fields
  quantidade_pega: number | null;
  separacao_parcial: boolean;
  parcial_motivo: string | null;
  parcial_em: string | null;
  realocacoes: Realocacao[];
}

interface ConsolidatedProduct {
  key: string;
  produto_id: string;
  sku: string;
  gtin: string | null;
  descricao: string;
  imagem_url: string | null;
  localizacao: string | null;
  empresa_origem_id: string | null;
  quantidade_total: number;
  all_marcado: boolean;
  item_ids: string[];
  is_oc: boolean;
  compra_status: ChecklistItem["compra_status"];
  saldo: number;
  disponivel: number;
}

type SortMode = "localizacao" | "sku" | "descricao";

type ScanFeedback = {
  text: string;
  tone: "ok" | "warn" | "error" | "neutral";
} | null;

// ──────────────────────────────────────────────────────────────────
// Helpers

function isOcStatus(s: ChecklistItem["compra_status"]): boolean {
  return s === "comprado" || s === "aguardando_compra" || s === "recebido";
}

function consolidar(items: ChecklistItem[]): {
  itensNormais: ConsolidatedProduct[];
  itensOC: ConsolidatedProduct[];
} {
  const buckets = new Map<string, ConsolidatedProduct>();

  for (const it of items) {
    const oc = isOcStatus(it.compra_status);
    const key = `${it.produto_id}_${oc ? "oc" : "norm"}`;
    const itemId = String(it.id);
    const existing = buckets.get(key);
    if (existing) {
      existing.quantidade_total += it.quantidade;
      existing.item_ids.push(itemId);
      if (!it.separacao_marcado) existing.all_marcado = false;
    } else {
      buckets.set(key, {
        key,
        produto_id: it.produto_id,
        sku: it.sku,
        gtin: it.gtin,
        descricao: it.descricao,
        imagem_url: it.imagem_url,
        localizacao: it.localizacao,
        empresa_origem_id: it.empresa_origem_id,
        quantidade_total: it.quantidade,
        all_marcado: it.separacao_marcado,
        item_ids: [itemId],
        is_oc: oc,
        compra_status: it.compra_status,
        saldo: it.saldo,
        disponivel: it.disponivel,
      });
    }
  }

  const all = Array.from(buckets.values());
  return {
    itensNormais: all.filter((p) => !p.is_oc),
    itensOC: all.filter((p) => p.is_oc),
  };
}

function ordenar(rows: ConsolidatedProduct[], sort: SortMode) {
  const copy = [...rows];
  copy.sort((a, b) => {
    if (sort === "sku") return a.sku.localeCompare(b.sku);
    if (sort === "descricao") return a.descricao.localeCompare(b.descricao);
    return naturalLocCompare(a.localizacao, b.localizacao);
  });
  return copy;
}

// ──────────────────────────────────────────────────────────────────
// Page

export default function WmsChecklistPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const pedidoIds = useMemo(
    () => (sp?.get("pedidos") ?? "").split(",").filter(Boolean),
    [sp],
  );
  const modo = (sp?.get("modo") ?? null) as "pick-oc" | null;

  // Mantém presença ativa em "Separação" durante o wave picking.
  useTrackPresencaWms("separacao");

  const [sort, setSort] = useState<SortMode>("localizacao");
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback>(null);
  const [esgotadoModal, setEsgotadoModal] = useState<{
    sku: string;
    loading: boolean;
    galpoes: Array<{ galpao_id: string; galpao_nome: string }>;
    pedidos_afetados: number;
  } | null>(null);
  const [ocLocModal, setOcLocModal] = useState<{
    produto: ConsolidatedProduct;
    bipando: boolean;
  } | null>(null);
  const [parcialModal, setParcialModal] = useState<{
    // Em modo realocação: itemIds[0] é o realocacao_id (sempre 1).
    // Em modo item: itemIds pode ter N items se a linha do checklist for
    // consolidada (mesmo SKU em pedidos diferentes do wave).
    itemIds: string[];
    isRealocacao: boolean;
    sku: string;
    localizacao: string | null;
    quantidade: number;
    loading: boolean;
  } | null>(null);
  const iniciarRef = useRef(false);
  const submittingActionRef = useRef<boolean>(false);

  // ─── Iniciar best-effort (ignora 400) ───
  useEffect(() => {
    if (iniciarRef.current) return;
    if (pedidoIds.length === 0 || !user) return;
    iniciarRef.current = true;
    sisoFetch("/api/wms/separacao/iniciar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pedido_ids: pedidoIds, operador_id: user.id }),
    }).catch(() => {
      // sessão já iniciada — segue baile
    });
  }, [pedidoIds, user]);

  // ─── Query itens ───
  const queryKey = useMemo(
    () => ["wms-sep-checklist", pedidoIds.join(","), modo ?? ""],
    [pedidoIds, modo],
  );

  // ─── Realtime: invalida o checklist quando outros operadores
  // mudam pedidos do wave ou criam/atualizam realocações ───
  useRealtimeSeparacao({
    pedidoIds,
    queryClient,
    queryKey,
  });

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const url = `/api/wms/separacao/checklist-items?pedidos=${pedidoIds.join(",")}${
        modo ? `&modo=${modo}` : ""
      }`;
      const r = await sisoFetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ items: ChecklistItem[] }>;
    },
    enabled: pedidoIds.length > 0 && !!user,
  });

  const items = useMemo(
    () =>
      (data?.items ?? []).map((item) => ({
        ...item,
        quantidade_pega: item.quantidade_pega ?? null,
        separacao_parcial: item.separacao_parcial ?? false,
        parcial_motivo: item.parcial_motivo ?? null,
        parcial_em: item.parcial_em ?? null,
        realocacoes: item.realocacoes ?? [],
      })) as ChecklistItem[],
    [data?.items],
  );

  const { itensNormais, itensOC } = useMemo(
    () => consolidar(items),
    [items],
  );
  const itensNormaisOrdenados = useMemo(
    () => ordenar(itensNormais, sort),
    [itensNormais, sort],
  );
  const itensOCOrdenados = useMemo(
    () => ordenar(itensOC, sort),
    [itensOC, sort],
  );

  // ─── Mutations ───

  const bipMutation = useMutation({
    mutationFn: async (codigo: string) => {
      const r = await sisoFetch("/api/wms/separacao/bipar-checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: codigo, pedido_ids: pedidoIds }),
      });
      if (r.status === 404) {
        const err: Error & { code?: number } = new Error("nao_encontrado");
        err.code = 404;
        throw err;
      }
      if (r.status === 409) {
        const err: Error & { code?: number } = new Error("ja_completo");
        err.code = 409;
        throw err;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json().catch(() => ({}));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({
      produto,
      marcado,
    }: {
      produto: ConsolidatedProduct;
      marcado: boolean;
    }) => {
      const results = await Promise.all(
        produto.item_ids.map((id) =>
          sisoFetch("/api/wms/separacao/marcar-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pedido_item_id: id, marcado }),
          }),
        ),
      );
      if (results.some((r) => !r.ok)) throw new Error("erro_marcar");
    },
  });

  const concluirMutation = useMutation({
    mutationFn: async () => {
      const endpoint =
        modo === "pick-oc"
          ? "/api/wms/separacao/concluir-oc"
          : "/api/wms/separacao/concluir";
      const r = await sisoFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: pedidoIds }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<{
        separados: string[];
        pendentes: string[];
        aguardandoCompra?: string[];
        cobertura_incompleta?: Array<{
          pedido_id: string;
          sku: string;
          recebido: number;
          solicitado: number;
          mensagem: string;
        }>;
      }>;
    },
  });

  const reiniciarMutation = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/separacao/reiniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pedido_ids: pedidoIds,
          etapa: "separacao",
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
    },
  });

  const cancelarMutation = useMutation({
    mutationFn: async () => {
      const r = await sisoFetch("/api/wms/separacao/cancelar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido_ids: pedidoIds }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
    },
  });

  // ─── Handlers ───

  async function handleScan(codigo: string) {
    setScanFeedback({ text: "Processando…", tone: "neutral" });
    try {
      await bipMutation.mutateAsync(codigo);
      setScanFeedback({ text: `Item bipado: ${codigo}`, tone: "ok" });
      queryClient.invalidateQueries({ queryKey });
    } catch (e) {
      const err = e as Error & { code?: number };
      if (err.code === 404) {
        setScanFeedback({
          text: `SKU "${codigo}" não encontrado neste wave`,
          tone: "error",
        });
      } else if (err.code === 409) {
        setScanFeedback({
          text: `"${codigo}" já bipado completamente`,
          tone: "warn",
        });
      } else {
        setScanFeedback({
          text: err.message || "Erro ao bipar",
          tone: "error",
        });
      }
    }
  }

  async function handleToggle(produto: ConsolidatedProduct) {
    const novo = !produto.all_marcado;

    // Optimistic
    queryClient.setQueryData<{ items: ChecklistItem[] }>(queryKey, (old) => {
      if (!old) return old;
      return {
        items: old.items.map((it) =>
          produto.item_ids.includes(String(it.id))
            ? {
                ...it,
                separacao_marcado: novo,
                separacao_marcado_em: novo
                  ? new Date().toISOString()
                  : null,
              }
            : it,
        ),
      };
    });

    try {
      await toggleMutation.mutateAsync({ produto, marcado: novo });
    } catch {
      toast.error("Erro ao salvar marcação");
      queryClient.invalidateQueries({ queryKey });
    }
  }

  async function handleEsgotadoPreview(sku: string) {
    try {
      const r = await sisoFetch("/api/wms/separacao/produto-esgotado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(body.error ?? "Erro ao verificar estoque");
        return;
      }
      setEsgotadoModal({
        sku,
        loading: false,
        galpoes: body.galpoes_alternativos ?? [],
        pedidos_afetados: body.pedidos_afetados ?? 0,
      });
    } catch {
      toast.error("Erro de conexão");
    }
  }

  async function handleEsgotadoAction(
    acao: "oc" | "encaminhar",
    galpao_destino_id?: string,
  ) {
    if (!esgotadoModal) return;
    const { sku } = esgotadoModal;
    setEsgotadoModal((p) => (p ? { ...p, loading: true } : null));
    try {
      const payload: Record<string, string> = { sku, acao };
      if (galpao_destino_id) payload.galpao_destino_id = galpao_destino_id;
      const r = await sisoFetch("/api/wms/separacao/produto-esgotado", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(body.error ?? "Erro ao processar");
        setEsgotadoModal((p) => (p ? { ...p, loading: false } : null));
        return;
      }
      if (acao === "encaminhar") {
        toast.success(
          `SKU ${sku} encaminhado para ${body.galpao_destino_nome ?? "outro galpão"} (${body.pedidos_afetados ?? 0} pedido(s))`,
        );
      } else {
        toast.success(
          `SKU ${sku} → OC (${body.pedidos_afetados ?? 0} pedido(s))`,
        );
      }
      setEsgotadoModal(null);
      if ((body.pedidos_afetados ?? 0) >= pedidoIds.length) {
        router.push("/wms/separacao");
        return;
      }
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexão");
      setEsgotadoModal((p) => (p ? { ...p, loading: false } : null));
    }
  }

  // D11: "encontrei" abre fluxo handheld de bipagem de localização
  async function handleOcEncontreiFinalizar(codigoLoc: string) {
    if (!ocLocModal) return;
    const { produto } = ocLocModal;
    setOcLocModal((p) => (p ? { ...p, bipando: true } : null));
    try {
      if (!produto.empresa_origem_id) {
        toast.error("Empresa de origem não encontrada");
        setOcLocModal(null);
        return;
      }
      // 1) atualiza localização do produto
      const rLoc = await sisoFetch("/api/wms/separacao/localizacao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          produto_id: Number(produto.produto_id),
          localizacao: codigoLoc.trim(),
          empresa_id: produto.empresa_origem_id,
        }),
      });
      if (!rLoc.ok) {
        const body = await rLoc.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao salvar localização");
        setOcLocModal((p) => (p ? { ...p, bipando: false } : null));
        return;
      }
      toast.success(`Localização: ${codigoLoc.trim()}`);

      // 2) valida OC item (endpoint legado — TODO Plano 3: criar reserva atômica
      //    em wms_inserir_movimentacao com origem_tipo=reserva_pedido_encontrei)
      const rVal = await sisoFetch("/api/wms/separacao/validar-oc-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: produto.item_ids,
          acao: "encontrei",
        }),
      });
      if (!rVal.ok) {
        const body = await rVal.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao validar item OC");
        setOcLocModal((p) => (p ? { ...p, bipando: false } : null));
        return;
      }
      const result = await rVal.json().catch(() => ({}));
      toast.success(`Item OC validado: ${produto.sku}`);
      setOcLocModal(null);
      queryClient.invalidateQueries({ queryKey });

      // auto-transições propagam o pedido pra próxima etapa
      if (Array.isArray(result.transicoes) && result.transicoes.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["wms-separacao"] });
        const transitioned = new Set<string>(
          result.transicoes.map((t: { pedido_id: string }) => t.pedido_id),
        );
        const todos = pedidoIds.every((id) => transitioned.has(id));
        if (todos) {
          toast.success("Todos os itens OC resolvidos");
          router.push("/wms/separacao");
        }
      }
    } catch {
      toast.error("Erro de conexão");
      setOcLocModal((p) => (p ? { ...p, bipando: false } : null));
    }
  }

  async function handleOcEsgotado(produto: ConsolidatedProduct) {
    try {
      const r = await sisoFetch("/api/wms/separacao/validar-oc-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: produto.item_ids,
          acao: "esgotado",
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao confirmar esgotado");
        return;
      }
      toast.success(`Item OC esgotado confirmado: ${produto.sku}`);
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexão");
    }
  }

  async function handleOcDesfazer(produto: ConsolidatedProduct) {
    try {
      const r = await sisoFetch("/api/wms/separacao/validar-oc-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: produto.item_ids,
          acao: "desfazer_encontrei",
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body.error ?? "Erro ao desfazer");
        return;
      }
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexão");
    }
  }

  // Handle parcial confirm
  async function handleParcialConfirm(qtyPega: number, locZerou: boolean) {
    if (!parcialModal) return;
    if (submittingActionRef.current) return;
    submittingActionRef.current = true;
    setParcialModal((prev) => (prev ? { ...prev, loading: true } : null));
    try {
      const body = parcialModal.isRealocacao
        ? { realocacao_ids: parcialModal.itemIds, quantidade_pega: qtyPega, loc_zerou: locZerou }
        : { pedido_item_ids: parcialModal.itemIds, quantidade_pega: qtyPega, loc_zerou: locZerou };

      const res = await sisoFetch("/api/wms/separacao/parcial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && data.error === "posicao_reservada") {
          toast.warning(
            `Posição reservada por outro pedido — saldo ${data.saldo}, disponível ${data.disponivel}. Avise o supervisor.`,
            { duration: 6000 },
          );
        } else if (
          res.status === 409 &&
          (data.error === "realocacao_ja_picada" || data.error === "race_item_ja_picado")
        ) {
          toast.warning("Outro operador picou primeiro — atualizando…", { duration: 4000 });
          queryClient.invalidateQueries({ queryKey });
        } else {
          toast.error(data.error ?? data.message ?? "Erro ao processar parcial");
        }
        setParcialModal(null);
        return;
      }
      if (data.status === "completo") {
        toast.success("Item marcado como completo");
      } else if (data.status === "realocado") {
        const locs = (data.realocacoes ?? [])
          .map((r: Realocacao) => r.localizacao_codigo)
          .join(", ");
        toast.success(
          `${data.realocacoes?.length ?? 0} loc(s) encontrada(s): ${locs}`,
        );
      } else if (data.status === "sem_cobertura") {
        // Cascade falhou — abre modal de encaminhar/OC automaticamente.
        // O modal usa o componente EsgotadoModal existente, alimentado por handleEsgotadoPreview.
        setParcialModal(null);
        queryClient.invalidateQueries({ queryKey });
        await handleEsgotadoPreview(parcialModal.sku);
        return;
      } else if (data.status === "aguardando_supervisor") {
        toast.warning("Sem cobertura — pedido voltou pro painel SISO", {
          duration: 6000,
        });
      }
      setParcialModal(null);
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexão");
      setParcialModal(null);
    } finally {
      submittingActionRef.current = false;
    }
  }

  // Handle marcar realocação (1 ou N — batch paralelo pra UI consolidada)
  async function handleMarcarRealocacao(realocacaoIds: string | string[]) {
    const ids = Array.isArray(realocacaoIds) ? realocacaoIds : [realocacaoIds];
    if (submittingActionRef.current) return;
    submittingActionRef.current = true;
    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await sisoFetch("/api/wms/separacao/marcar-realocacao", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ realocacao_id: id }),
          });
          const data = await res.json().catch(() => ({}));
          return { res, data };
        }),
      );
      const erradas = results.filter((r) => !r.res.ok);
      if (erradas.length > 0) {
        // Distinguir 409 conhecidos pra dar feedback melhor
        const reservada = erradas.find(
          (r) => r.res.status === 409 && r.data?.error === "posicao_reservada",
        );
        const jaPicada = erradas.find(
          (r) =>
            r.res.status === 409 &&
            (r.data?.error === "realocacao_ja_picada" || r.data?.error === "race_item_ja_picado"),
        );
        if (reservada) {
          toast.warning(
            `Posição reservada por outro pedido — saldo ${reservada.data?.saldo ?? "?"}, disponível ${reservada.data?.disponivel ?? "?"}. Avise o supervisor.`,
            { duration: 6000 },
          );
        } else if (jaPicada) {
          toast.warning("Outro operador picou primeiro — atualizando…", { duration: 4000 });
        } else {
          toast.error(
            erradas.length === ids.length
              ? "Erro ao marcar realocação"
              : `${ids.length - erradas.length}/${ids.length} marcada(s) — algumas falharam`,
          );
        }
      } else {
        toast.success(
          ids.length === 1 ? "Realocação picada" : `${ids.length} realocações picadas`,
        );
      }
      queryClient.invalidateQueries({ queryKey });
    } catch {
      toast.error("Erro de conexão");
    } finally {
      submittingActionRef.current = false;
    }
  }

  async function handleConcluir() {
    try {
      const result = await concluirMutation.mutateAsync();
      const sep = result.separados?.length ?? 0;
      const pen = result.pendentes?.length ?? 0;
      const ag = result.aguardandoCompra?.length ?? 0;
      const incompletos = result.cobertura_incompleta ?? [];
      const pedidosIncompletos = new Set(incompletos.map((c) => c.pedido_id));
      const partes: string[] = [];
      if (sep > 0) partes.push(`${sep} separado(s)`);
      if (ag > 0) partes.push(`${ag} aguardando compra`);
      if (pen > 0) partes.push(`${pen} pendente(s)`);
      if (pedidosIncompletos.size > 0) {
        partes.push(`${pedidosIncompletos.size} pendente(s) de cobertura OC`);
      }
      const msg = partes.length > 0 ? partes.join(" · ") : "Concluído";
      if (pedidosIncompletos.size > 0) {
        const primeiraMsg = incompletos[0]?.mensagem ?? "";
        toast.warning(`${msg}${primeiraMsg ? ` — ${primeiraMsg}` : ""}`);
      } else {
        toast.success(msg);
      }
      queryClient.invalidateQueries({ queryKey: ["wms-separacao"] });
      if (ag > 0 && sep === 0) {
        router.push("/wms/separacao?tab=aguardando_compra");
      } else {
        router.push("/wms/separacao?tab=separado");
      }
    } catch (e) {
      toast.error((e as Error).message || "Erro ao concluir");
    }
  }

  async function handleReiniciar() {
    if (
      !window.confirm(
        "Reiniciar progresso? Todas as marcações serão desmarcadas.",
      )
    )
      return;
    try {
      await reiniciarMutation.mutateAsync();
      toast.success("Progresso reiniciado");
      queryClient.invalidateQueries({ queryKey });
    } catch (e) {
      toast.error((e as Error).message || "Erro ao reiniciar");
    }
  }

  async function handleCancelar() {
    const destino =
      modo === "pick-oc" ? "Aguardando OC" : "Aguardando separação";
    if (
      !window.confirm(
        `Cancelar separação? Pedidos voltam para ${destino}.`,
      )
    )
      return;
    try {
      await cancelarMutation.mutateAsync();
      toast.success("Separação cancelada");
      queryClient.invalidateQueries({ queryKey: ["wms-separacao"] });
      router.push("/wms/separacao");
    } catch (e) {
      toast.error((e as Error).message || "Erro ao cancelar");
    }
  }

  // ─── Empty state ───

  if (pedidoIds.length === 0) {
    return (
      <>
        <PageHeader
          title="Wave picking"
          subtitle="Nenhum pedido selecionado"
          backHref="/wms/separacao"
        />
        <div className="wms-empty-block">
          <h3>Nenhum pedido selecionado</h3>
          <p>
            Volte para a lista de separação e escolha pedidos pra fazer
            wave picking.
          </p>
          <a href="/wms/separacao" className="wms-btn wms-btn-primary">
            <Icon name="arrow-left" size={11} />
            Voltar para Separação
          </a>
        </div>
      </>
    );
  }

  // ─── Render ───

  const totalItens = items.length;
  const totalProdutos = itensNormais.length + itensOC.length;
  const marcados =
    itensNormais.filter((p) => p.all_marcado).length +
    itensOC.filter((p) => p.all_marcado).length;
  const ocPendentes = itensOC.filter((p) => !p.all_marcado).length;

  return (
    <>
      <PageHeader
        title={`Wave picking — ${pedidoIds.length} pedido${pedidoIds.length === 1 ? "" : "s"}`}
        subtitle={
          isLoading
            ? "Carregando itens…"
            : `${totalItens} ite${totalItens === 1 ? "m" : "ns"} · ${marcados}/${totalProdutos} produto(s) marcado(s)${modo === "pick-oc" ? " · pick-OC" : ""}`
        }
        backHref="/wms/separacao"
      >
        <select
          className="wms-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
        >
          <option value="localizacao">Ordenar: localização</option>
          <option value="sku">Ordenar: SKU</option>
          <option value="descricao">Ordenar: descrição</option>
        </select>
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          disabled={reiniciarMutation.isPending}
          onClick={handleReiniciar}
        >
          <Icon name="rotate" size={11} />
          Reiniciar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          disabled={cancelarMutation.isPending}
          onClick={handleCancelar}
        >
          <Icon name="x" size={11} />
          Cancelar
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={concluirMutation.isPending}
          onClick={handleConcluir}
        >
          <Icon name="check" size={11} />
          {concluirMutation.isPending ? "Processando…" : "Concluir"}
        </button>
      </PageHeader>

      <HandheldScan
        label="Bipe SKU ou GTIN"
        placeholder="Bipe ou digite e Enter..."
        onSubmit={handleScan}
        feedback={scanFeedback}
        pending={bipMutation.isPending}
      />

      {isLoading ? (
        <div className="wms-loading-pane">Carregando itens…</div>
      ) : totalProdutos === 0 ? (
        <div className="wms-empty-block">
          <h3>Nenhum item para separar</h3>
          <p>
            Os pedidos selecionados não retornaram itens elegíveis para wave
            picking.
          </p>
        </div>
      ) : (
        <>
          {/* ─── Itens normais ─── */}
          <h2 className="wms-sec-h">
            Itens a separar ({itensNormaisOrdenados.length})
          </h2>
          {itensNormaisOrdenados.length === 0 ? (
            <div className="wms-exp-empty">
              Nenhum item normal nesse wave — só OC.
            </div>
          ) : (
            <div>
              {itensNormaisOrdenados.map((p) => {
                const underlyingItems = items.filter((i) =>
                  p.item_ids.includes(String(i.id)),
                );
                const parcialItem = underlyingItems.find(
                  (i) => i.separacao_parcial,
                );
                const isParcial = !!parcialItem;
                const firstItemId = p.item_ids[0] ?? "";
                return (
                  <ItemRow
                    key={p.key}
                    produto={p}
                    isParcial={isParcial}
                    parcialItem={parcialItem}
                    submitting={toggleMutation.isPending}
                    onToggle={() => handleToggle(p)}
                    onParcial={() =>
                      setParcialModal({
                        itemIds: p.item_ids,
                        isRealocacao: false,
                        sku: p.sku,
                        localizacao: p.localizacao,
                        quantidade: p.quantidade_total,
                        loading: false,
                      })
                    }
                  />
                );
              })}
            </div>
          )}

          {/* ─── Realocações — agrupadas por loc+status pra UI consolidada ─── */}
          {(() => {
            type LinhaRaw = { item: ChecklistItem; realocacao: Realocacao };
            const realocacaoLinhas: LinhaRaw[] = [];
            for (const item of items) {
              if (item.compra_status === "oc_pendente") continue;
              for (const r of item.realocacoes ?? []) {
                realocacaoLinhas.push({ item, realocacao: r });
              }
            }
            if (realocacaoLinhas.length === 0) return null;

            // Agrupa por chave (sku + loc + status group)
            // Plano ledger simplificado 3D: sem is_emprestimo/empresa no key — pool fungível.
            // Status group: "ativa" (aguardando_picking) | "picada" (picado/picado_parcial) | "cancelada"
            type Grupo = {
              key: string;
              sku: string;
              item_primeiro: ChecklistItem;
              realocs: Realocacao[];
              status_group: "ativa" | "picada" | "cancelada";
              localizacao_codigo: string;
              qty_sugerida_total: number;
              qty_pega_total: number;
              criado_em_primeiro: string;
            };

            const grupos = new Map<string, Grupo>();
            for (const { item, realocacao: r } of realocacaoLinhas) {
              const statusGroup =
                r.status === "aguardando_picking"
                  ? "ativa"
                  : r.status === "cancelado"
                    ? "cancelada"
                    : "picada"; // picado + picado_parcial juntos no histórico

              const key = [item.sku, r.localizacao_codigo, statusGroup].join(
                "|",
              );

              const existente = grupos.get(key);
              if (existente) {
                existente.realocs.push(r);
                existente.qty_sugerida_total += r.quantidade;
                existente.qty_pega_total += r.quantidade_pega ?? 0;
                if (r.criado_em < existente.criado_em_primeiro) {
                  existente.criado_em_primeiro = r.criado_em;
                }
              } else {
                grupos.set(key, {
                  key,
                  sku: item.sku,
                  item_primeiro: item,
                  realocs: [r],
                  status_group: statusGroup,
                  localizacao_codigo: r.localizacao_codigo,
                  qty_sugerida_total: r.quantidade,
                  qty_pega_total: r.quantidade_pega ?? 0,
                  criado_em_primeiro: r.criado_em,
                });
              }
            }

            const gruposOrdenados = [...grupos.values()].sort((a, b) =>
              a.criado_em_primeiro.localeCompare(b.criado_em_primeiro),
            );

            return (
              <>
                <h2 className="wms-sec-h">
                  Realocações ({gruposOrdenados.length})
                </h2>
                <div>
                  {gruposOrdenados.map((g) => {
                    const realocIds = g.realocs.map((r) => r.id);
                    const realocAgregada: Realocacao = {
                      ...g.realocs[0],
                      quantidade: g.qty_sugerida_total,
                      quantidade_pega:
                        g.status_group === "ativa" ? null : g.qty_pega_total,
                      // status visual: pega o "pior" status do grupo pra mostrar parcial
                      status:
                        g.status_group === "ativa"
                          ? "aguardando_picking"
                          : g.status_group === "cancelada"
                            ? "cancelado"
                            : g.realocs.some((r) => r.status === "picado_parcial")
                              ? "picado_parcial"
                              : "picado",
                    };
                    return (
                      <RealocacaoRow
                        key={`realoc-grp-${g.key}`}
                        item={g.item_primeiro}
                        realocacao={realocAgregada}
                        onMarcar={() => handleMarcarRealocacao(realocIds)}
                        onParcial={() =>
                          setParcialModal({
                            itemIds: realocIds,
                            isRealocacao: true,
                            sku: g.sku,
                            localizacao: g.localizacao_codigo,
                            quantidade: g.qty_sugerida_total,
                            loading: false,
                          })
                        }
                      />
                    );
                  })}
                </div>
              </>
            );
          })()}

          {/* ─── Itens OC ─── */}
          {itensOCOrdenados.length > 0 && (
            <section className="wms-hand-section-oc">
              <h2 className="wms-hand-section-oc-h">
                <Icon name="alert" size={13} />
                Itens OC ({itensOCOrdenados.length}) — validar
                {ocPendentes > 0 && (
                  <span
                    className="wms-td-mute"
                    style={{ fontSize: 11.5, fontWeight: 400 }}
                  >
                    · {ocPendentes} pendente(s)
                  </span>
                )}
              </h2>
              <div>
                {itensOCOrdenados.map((p) => (
                  <ItemRowOC
                    key={p.key}
                    produto={p}
                    onEncontrei={() =>
                      setOcLocModal({ produto: p, bipando: false })
                    }
                    onEsgotado={() => handleOcEsgotado(p)}
                    onDesfazer={() => handleOcDesfazer(p)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* ─── Modal parcial ─── */}
      {parcialModal && (
        <ParcialModal
          open
          sku={parcialModal.sku}
          localizacao={parcialModal.localizacao}
          quantidadePedida={parcialModal.quantidade}
          loading={parcialModal.loading}
          onConfirm={handleParcialConfirm}
          onCancel={() => setParcialModal(null)}
        />
      )}

      {/* ─── Modal esgotado (itens normais) ─── */}
      {esgotadoModal && (
        <EsgotadoModal
          sku={esgotadoModal.sku}
          galpoes={esgotadoModal.galpoes}
          pedidosAfetados={esgotadoModal.pedidos_afetados}
          loading={esgotadoModal.loading}
          onClose={() =>
            !esgotadoModal.loading && setEsgotadoModal(null)
          }
          onEncaminhar={(galpaoId) =>
            handleEsgotadoAction("encaminhar", galpaoId)
          }
          onCriarOC={() => handleEsgotadoAction("oc")}
        />
      )}

      {/* ─── Modal handheld "encontrei" — bipar localização ─── */}
      {ocLocModal && (
        <OcEncontreiModal
          produto={ocLocModal.produto}
          bipando={ocLocModal.bipando}
          onClose={() => !ocLocModal.bipando && setOcLocModal(null)}
          onConfirmar={handleOcEncontreiFinalizar}
        />
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────
// ItemRow — linha de produto normal (bipável)

function ItemRow({
  produto,
  isParcial,
  parcialItem,
  submitting,
  onToggle,
  onParcial,
}: {
  produto: ConsolidatedProduct;
  isParcial: boolean;
  parcialItem: ChecklistItem | undefined;
  submitting?: boolean;
  onToggle: () => void;
  onParcial: () => void;
}) {
  const done = produto.all_marcado;
  const multi = produto.quantidade_total > 1;
  const handleToggleClick = () => {
    if (submitting) return;
    onToggle();
  };
  return (
    <div
      className={`wms-hand-item${done ? " is-done" : ""}`}
      style={{ gridTemplateColumns: "28px 44px minmax(0,1fr) 56px 170px" }}
    >
      <div
        role="button"
        tabIndex={0}
        className="wms-hand-item-check"
        onClick={handleToggleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggleClick();
          }
        }}
        aria-label={done ? "Desmarcar item" : "Marcar item"}
      >
        {done ? <Icon name="check" size={12} /> : null}
      </div>
      {produto.imagem_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={produto.imagem_url}
          alt={produto.sku}
          className="wms-thumb wms-thumb-sm"
          loading="lazy"
        />
      ) : (
        <div
          className="wms-thumb wms-thumb-sm"
          style={{
            display: "grid",
            placeItems: "center",
            background: "var(--wms-c-faint)",
          }}
        >
          <Icon name="box" size={16} className="wms-td-mute" />
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          className="wms-mono"
          style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
        >
          {produto.sku}
          {isParcial && parcialItem && (
            <span
              className="wms-badge wms-badge-warn"
              style={{ fontSize: 10, fontWeight: 700 }}
            >
              Parcial {parcialItem.quantidade_pega}/{parcialItem.quantidade}
            </span>
          )}
        </div>
        <div
          className="wms-td-mute"
          style={{
            fontSize: 11.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {produto.descricao}
        </div>
        <div style={{ fontSize: 11, marginTop: 2 }}>
          <span className="wms-hand-item-loc">
            {produto.localizacao || "Sem loc"}
          </span>
          <span className="wms-td-mute"> · saldo {fmtNum(produto.disponivel)}</span>
          {produto.gtin && (
            <span className="wms-td-mute"> · GTIN {produto.gtin}</span>
          )}
        </div>
      </div>
      <div
        className="wms-mono wms-tar"
        style={{
          fontWeight: 700,
          fontSize: multi ? 22 : 16,
          color: multi ? "#0d9488" : undefined,
        }}
      >
        {produto.quantidade_total}
      </div>
      <div
        className="wms-tar"
        style={{ display: "flex", flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "flex-end" }}
      >
        {!done && !isParcial && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onParcial}
            title={`Pegar parcialmente: ${produto.sku}`}
            style={{
              color: "var(--wms-c-warn, #b45309)",
              borderColor: "var(--wms-c-warn, #b45309)",
            }}
          >
            Parcial
          </button>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// ItemRowOC — linha de produto OC (validar encontrei / esgotado)

function ItemRowOC({
  produto,
  onEncontrei,
  onEsgotado,
  onDesfazer,
}: {
  produto: ConsolidatedProduct;
  onEncontrei: () => void;
  onEsgotado: () => void;
  onDesfazer: () => void;
}) {
  const done = produto.all_marcado;
  const multi = produto.quantidade_total > 1;
  return (
    <div
      className={`wms-hand-item is-oc${done ? " is-done" : ""}`}
      style={{ gridTemplateColumns: "28px 44px minmax(0,1fr) 56px 170px" }}
    >
      <div
        className="wms-hand-item-check"
        style={{ cursor: "default" }}
        aria-hidden
      >
        {done ? <Icon name="check" size={12} /> : null}
      </div>
      {produto.imagem_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={produto.imagem_url}
          alt={produto.sku}
          className="wms-thumb wms-thumb-sm"
          loading="lazy"
        />
      ) : (
        <div
          className="wms-thumb wms-thumb-sm"
          style={{
            display: "grid",
            placeItems: "center",
            background: "var(--wms-c-faint)",
          }}
        >
          <Icon name="box" size={16} className="wms-td-mute" />
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <span className="wms-mono" style={{ fontWeight: 600, fontSize: 13 }}>
            {produto.sku}
          </span>
          <span
            className="wms-badge wms-badge-warn"
            style={{ fontSize: 10 }}
          >
            OC
          </span>
        </div>
        <div
          className="wms-td-mute"
          style={{
            fontSize: 11.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {produto.descricao}
        </div>
        <div style={{ fontSize: 11, marginTop: 2 }}>
          <span className="wms-hand-item-loc">
            {produto.localizacao || "Sem loc"}
          </span>
          <span className="wms-td-mute"> · saldo {fmtNum(produto.disponivel)}</span>
        </div>
      </div>
      <div
        className="wms-mono wms-tar"
        style={{
          fontWeight: 700,
          fontSize: multi ? 22 : 16,
          color: multi ? "#0d9488" : undefined,
        }}
      >
        {produto.quantidade_total}
      </div>
      <div
        className="wms-tar"
        style={{ display: "flex", flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "flex-end" }}
      >
        {done ? (
          <button
            type="button"
            className="wms-btn wms-btn-sm wms-btn-ghost"
            onClick={onDesfazer}
            title="Desfazer encontrei"
          >
            Desfazer
          </button>
        ) : (
          <>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-primary"
              onClick={onEncontrei}
              title="Encontrei o item — bipar localização"
            >
              Encontrei
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-ghost"
              onClick={onEsgotado}
              title="Confirmar esgotado"
            >
              Esgotado
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// RealocacaoRow — linha de realocação (cascade); aceita Parcial + checkbox

function RealocacaoRow({
  item,
  realocacao: r,
  onMarcar,
  onParcial,
}: {
  item: ChecklistItem;
  realocacao: Realocacao;
  onMarcar: () => void;
  onParcial: () => void;
}) {
  const isActive = r.status === "aguardando_picking";
  const isPicadoCompleto = r.status === "picado";
  const isPicadoParcial = r.status === "picado_parcial";
  const isCancelado = r.status === "cancelado";

  const badgeLabel = isPicadoCompleto
    ? "Picado"
    : isPicadoParcial
      ? `Picado ${r.quantidade_pega ?? 0}/${r.quantidade}`
      : isCancelado
        ? "Cancelada"
        : "Aguardando";

  const badgeClass = isPicadoCompleto
    ? "wms-badge wms-badge-ok"
    : isCancelado || isPicadoParcial
      ? "wms-badge"
      : "wms-badge wms-badge-warn";

  const rowStyle: React.CSSProperties = isActive
    ? {
        borderColor: "var(--wms-c-warn-border, #fcd34d)",
        background: "var(--wms-c-warn-faint, #fffbeb)",
      }
    : isPicadoCompleto
      ? {
          borderColor: "var(--wms-c-ok-border, #a7f3d0)",
          background: "var(--wms-c-ok-faint, #ecfdf5)",
          opacity: 0.85,
        }
      : {
          opacity: 0.6,
        };

  return (
    <div
      className="wms-hand-item"
      style={{
        gridTemplateColumns: "28px 44px minmax(0,1fr) 56px 170px",
        ...rowStyle,
      }}
    >
      <div
        role={isActive ? "button" : undefined}
        tabIndex={isActive ? 0 : -1}
        className="wms-hand-item-check"
        onClick={isActive ? onMarcar : undefined}
        onKeyDown={
          isActive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onMarcar();
                }
              }
            : undefined
        }
        style={{ cursor: isActive ? "pointer" : "default" }}
        aria-label={isActive ? "Marcar como picado" : undefined}
      >
        {(isPicadoCompleto || isPicadoParcial) && <Icon name="check" size={12} />}
      </div>
      {item.imagem_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imagem_url}
          alt={item.sku}
          className="wms-thumb wms-thumb-sm"
          loading="lazy"
        />
      ) : (
        <div
          className="wms-thumb wms-thumb-sm"
          style={{
            display: "grid",
            placeItems: "center",
            background: "var(--wms-c-faint)",
          }}
        >
          <Icon name="box" size={16} className="wms-td-mute" />
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span className="wms-mono" style={{ fontWeight: 600, fontSize: 13 }}>
            {item.sku}
          </span>
          <span className={badgeClass} style={{ fontSize: 10 }}>
            {badgeLabel}
          </span>
          <span
            className="wms-badge wms-badge-warn"
            style={{ fontSize: 10 }}
          >
            Realocada
          </span>
        </div>
        <div style={{ fontSize: 11, marginTop: 2 }}>
          <span className="wms-hand-item-loc">{r.localizacao_codigo}</span>
          <span className="wms-td-mute"> ← de {item.localizacao ?? "sem loc"}</span>
        </div>
      </div>
      <div
        className="wms-mono wms-tar"
        style={{ fontWeight: 700, fontSize: 16 }}
      >
        {r.quantidade}
      </div>
      <div
        className="wms-tar"
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        {isActive && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onParcial}
            title="Pegar parcialmente"
            style={{
              color: "var(--wms-c-warn, #b45309)",
              borderColor: "var(--wms-c-warn, #b45309)",
            }}
          >
            Parcial
          </button>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// EsgotadoModal — escolha encaminhar para outro galpão ou criar OC

function EsgotadoModal({
  sku,
  galpoes,
  pedidosAfetados,
  loading,
  onClose,
  onEncaminhar,
  onCriarOC,
}: {
  sku: string;
  galpoes: Array<{ galpao_id: string; galpao_nome: string }>;
  pedidosAfetados: number;
  loading: boolean;
  onClose: () => void;
  onEncaminhar: (galpaoId: string) => void;
  onCriarOC: () => void;
}) {
  return (
    <div className="wms-md-overlay" onClick={onClose}>
      <div
        className="wms-md"
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wms-md-hd">
          <div>
            <h3>SKU {sku} — Esgotado</h3>
            <p className="wms-td-mute" style={{ fontSize: 12.5 }}>
              {pedidosAfetados} pedido(s) afetado(s). O que deseja fazer?
            </p>
          </div>
          <button
            className="wms-btn-icon wms-btn-icon-lg"
            onClick={onClose}
            aria-label="Fechar"
            disabled={loading}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="wms-md-body">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {galpoes.length === 0 && (
              <div className="wms-td-mute" style={{ fontSize: 12.5 }}>
                Nenhum outro galpão tem estoque suficiente — só dá pra criar OC.
              </div>
            )}
            {galpoes.map((g) => (
              <button
                key={g.galpao_id}
                type="button"
                className="wms-btn wms-btn-ghost"
                disabled={loading}
                onClick={() => onEncaminhar(g.galpao_id)}
                style={{ justifyContent: "flex-start" }}
              >
                <Icon name="arrow-right" size={11} />
                Encaminhar para {g.galpao_nome}
              </button>
            ))}
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={loading}
              onClick={onCriarOC}
              style={{ justifyContent: "center" }}
            >
              <Icon name="clipboard" size={11} />
              {loading ? "Processando…" : "Criar Ordem de Compra"}
            </button>
          </div>
        </div>
        <div className="wms-md-ft">
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onClose}
            disabled={loading}
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// OcEncontreiModal — fluxo handheld: bipar localização do item OC encontrado

function OcEncontreiModal({
  produto,
  bipando,
  onClose,
  onConfirmar,
}: {
  produto: ConsolidatedProduct;
  bipando: boolean;
  onClose: () => void;
  onConfirmar: (codigoLoc: string) => void;
}) {
  const [feedback, setFeedback] = useState<ScanFeedback>({
    text: `Bipe a localização onde encontrou ${produto.sku}`,
    tone: "neutral",
  });

  function handleSubmit(codigo: string) {
    if (!codigo.trim()) {
      setFeedback({ text: "Código vazio", tone: "warn" });
      return;
    }
    setFeedback({ text: `Salvando ${codigo.trim()}…`, tone: "neutral" });
    onConfirmar(codigo.trim());
  }

  return (
    <div className="wms-md-overlay" onClick={onClose}>
      <div
        className="wms-md"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wms-md-hd">
          <div>
            <h3>Encontrei: {produto.sku}</h3>
            <p className="wms-td-mute" style={{ fontSize: 12.5 }}>
              {produto.descricao}
            </p>
          </div>
          <button
            className="wms-btn-icon wms-btn-icon-lg"
            onClick={onClose}
            aria-label="Fechar"
            disabled={bipando}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="wms-md-body">
          <div
            style={{
              padding: 14,
              border: "1px solid var(--wms-c-border)",
              background: "var(--wms-c-faint)",
              borderRadius: "var(--wms-r-3)",
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            <div
              className="wms-td-mute"
              style={{ fontSize: 10.5, letterSpacing: 1, marginBottom: 4 }}
            >
              QTD A SEPARAR
            </div>
            <div
              className="wms-mono"
              style={{ fontSize: 28, fontWeight: 700, lineHeight: 1 }}
            >
              {produto.quantidade_total}
            </div>
          </div>
          <HandheldScan
            label="Bipe a localização do item encontrado"
            placeholder="Ex: A1-02 ou QR da loc..."
            onSubmit={handleSubmit}
            feedback={feedback}
            pending={bipando}
          />
        </div>
        <div className="wms-md-ft">
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            onClick={onClose}
            disabled={bipando}
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

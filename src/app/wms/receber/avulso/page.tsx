"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch, usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader, Field } from "@/components/wms/ui/wms-ui";
import {
  RECEBER_ORIGEM_OPTS,
  type ReceberOrigem,
  origemToBackend,
  hojeISODate,
  buildTimestamp,
  useGalpoes,
} from "@/components/wms/ui/modals";
import {
  ReceberLote,
  emptyReceberLoteItem,
  type ReceberLoteSubmitCtx,
} from "@/components/wms/recebimento/receber-lote";
import type {
  ReceberLoteItem,
  ReceberLoteConfig,
} from "@/components/wms/recebimento/receber-lote-types";
import type { Produto } from "@/lib/wms/types";

export default function ReceberPage() {
  return (
    <>
      <PageHeader
        title="Receber mercadoria"
        subtitle="Etapa 1 de 2 — registra entrada no dock RECEBIMENTO e decide a loc destino. Pra 1 SKU ou N: tudo na mesma tela. A guarda física é feita em /wms/guarda (tablet), em rota agrupada por lote."
      />
      <Suspense fallback={null}>
        <ReceberBody />
      </Suspense>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// ReceberBody (avulso): wrapper fino sobre <ReceberLote>. Bipa 1..N SKUs
// no recebimento. Cada linha pode receber uma loc destino sugerida/escolhida
// — agrupadas no Plano de guarda à direita (renderizado pelo componente
// compartilhado). Confirmação cria 1 lote (UUID compartilhado entre as
// pendências) que vira 1 rota única no tablet de guarda. Aceita
// `?produto_id=` pra pré-selecionar o produto vindo de outra tela
// (produto-drawer, linha de estoque, command-K).

const CONFIG_AVULSO: ReceberLoteConfig = {
  fluxo: "avulso",
  canAddItems: true,
  productEditable: true,
  qtyEditable: true,
  custoVisible: true,
  custoObrigatorio: true,
  locPickVisible: true,
  locObrigatoria: false,
  divergenciaVisible: false,
  imprimirVisible: true,
  mlBlockVisible: true,
  planoSidebarVisible: true,
  leftFormVisible: true,
  permissaoReceber: "operacoes.receber",
  putawaySuggest: true,
};

interface ReceberResponse {
  ok: boolean;
  pendencia_ids: string[];
  localizacao_recebimento_id: string | null;
  lote_id: string;
  mov_ids?: string[];
}

interface EmpresaLite {
  id: string;
  nome: string;
}

interface FornecedorLite {
  id: string;
  nome: string;
}

function ReceberBody() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = usePermissoes();
  const podeReceber = can("operacoes.receber");
  const produtoIdSeed = searchParams.get("produto_id");
  const { data: galpoes } = useGalpoes();
  const galpoesList = useMemo(() => galpoes ?? [], [galpoes]);
  const defaultGalpao = galpoesList[0];

  const empresasQuery = useQuery({
    queryKey: ["wms-empresas-lite"],
    queryFn: () => wmsApi<EmpresaLite[]>(`/api/wms/admin/empresas`),
  });
  const fornecedoresQuery = useQuery({
    queryKey: ["wms-fornecedores-lite"],
    queryFn: () =>
      wmsApi<{ rows: FornecedorLite[] }>(`/api/wms/fornecedores`),
  });
  const empresas = empresasQuery.data ?? [];
  const fornecedores = fornecedoresQuery.data?.rows ?? [];

  const [galpaoIdUser, setGalpaoIdUser] = useState<string | null>(null);
  // Empresa compradora — exigida apenas em origem='nf_compra' (NF de compra).
  const [empresaCompradoraId, setEmpresaCompradoraId] = useState<string>("");
  // Fornecedor — sempre exigido pela API.
  const [fornecedorId, setFornecedorId] = useState<string>("");
  const [nf, setNf] = useState("");
  const [motivo, setMotivo] = useState("");
  const [origem, setOrigem] = useState<ReceberOrigem>("compra_manual");
  const [data, setData] = useState<string>(hojeISODate());
  const [obs, setObs] = useState("");

  const galpaoId = galpaoIdUser ?? defaultGalpao?.id ?? "";
  const today = hojeISODate();
  const isRetroativo = data !== today;

  // ── seed via ?produto_id= ────────────────────────────────────────────
  // Pré-seleciona produto se veio via `?produto_id=` (origem: produto-drawer,
  // linha de estoque, command-K). Roda 1× só — depois o operador edita à
  // vontade. Limpa a URL pra não re-seedar em reload (o que também desabilita
  // a query, já que `produtoIdSeed` vira null).
  const seedQuery = useQuery({
    queryKey: ["wms-receber-seed", produtoIdSeed],
    queryFn: () => wmsApi<Produto>(`/api/wms/produtos/${produtoIdSeed}`),
    enabled: !!produtoIdSeed,
    staleTime: 60 * 1000,
  });
  const seedProduto = seedQuery.data ?? null;

  // itensIniciais: a 1ª linha vazia, com o produto seedado quando chega.
  // O <ReceberLote> só adota o produto se a 1ª linha estiver vazia.
  const itensIniciais = useMemo<ReceberLoteItem[]>(
    () => [seedProduto ? { ...emptyReceberLoteItem(), produto: seedProduto } : emptyReceberLoteItem()],
    [seedProduto],
  );

  // Limpa a query string 1× quando o seed chega (evita re-seed em reload).
  const seedUrlLimpaRef = useRef(false);
  useEffect(() => {
    if (seedUrlLimpaRef.current) return;
    if (!seedProduto) return;
    seedUrlLimpaRef.current = true;
    router.replace("/wms/receber", { scroll: false });
  }, [seedProduto, router]);

  // ── submit: monta o body 3D + POST + impressão fire-and-forget ─────────
  async function submit(itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) {
    const itensOut: Array<{
      produto_id: string;
      qty: number;
      custo_unitario: number;
      localizacao_destino_id?: string;
    }> = [];
    const printIndices: number[] = [];
    itens.forEach((it) => {
      if (!it.produto) return;
      const qtyN = Number(it.qty);
      if (!qtyN || qtyN <= 0) return;
      const custoN = Number(it.custo);
      if (!Number.isFinite(custoN) || custoN < 0) return;
      itensOut.push({
        produto_id: it.produto.id,
        qty: qtyN,
        custo_unitario: custoN,
        localizacao_destino_id: it.locIdOverride ?? undefined,
      });
      if (it.imprimir) {
        printIndices.push(itensOut.length - 1);
      }
    });
    if (itensOut.length === 0) {
      throw new Error("nenhum item válido pra enviar (qty>0 e custo>=0)");
    }
    const origemFinal = isRetroativo
      ? "lancamento_retroativo"
      : origemToBackend(origem);
    // 3D body shape — sem empresa_dona_id; com empresa_compradora_id,
    // fornecedor_id e motivo opcionais (compradora vira obrigatória na
    // API quando origem='nf_compra').
    const r = await sisoFetch("/api/wms/receber", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        galpao_id: ctx.galpaoId,
        empresa_compradora_id: empresaCompradoraId || undefined,
        fornecedor_id: fornecedorId || undefined,
        nf_referencia: nf || undefined,
        motivo: motivo || undefined,
        origem_tipo: origemFinal,
        observacoes: obs || undefined,
        data_recebimento: buildTimestamp(data),
        entrada_direta: ctx.entradaDireta,
        itens: itensOut,
      }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    return {
      resp: (await r.json()) as ReceberResponse,
      itensOut,
      printIndices,
    };
  }

  function onSuccess(
    out: unknown,
    _itens: ReceberLoteItem[],
    ctx: ReceberLoteSubmitCtx,
  ) {
    const { resp, itensOut, printIndices } = out as {
      resp: ReceberResponse;
      itensOut: Array<{
        produto_id: string;
        qty: number;
        custo_unitario: number;
        localizacao_destino_id?: string;
      }>;
      printIndices: number[];
    };
    const entradaDireta = ctx.entradaDireta;

    if (entradaDireta) {
      toast.success(
        `Lote em estoque: ${itensOut.length} ite${itensOut.length > 1 ? "ns" : "m"} direto na loc destino`,
      );
    } else {
      toast.success(
        `Lote registrado: ${resp.pendencia_ids.length} pendência${resp.pendencia_ids.length > 1 ? "s" : ""} de guarda`,
      );
    }

    // Imprime maço fire-and-forget só dos itens que o operador marcou
    // pra imprimir. Em modo guarda usa pendencia_ids; em entrada_direta
    // monta `linhas` a partir dos itens enviados. Alinhamento por índice
    // é seguro: `resp.pendencia_ids` segue a ordem de `itensOut` (verificado
    // em receberEstoque — push sequencial sem reordenação).
    if (printIndices.length > 0) {
      const idxSet = new Set(printIndices);
      const linhas = entradaDireta
        ? itensOut
            .map((item, idx) => ({ item, idx }))
            .filter(({ item, idx }) => idxSet.has(idx) && !!item.localizacao_destino_id)
            .map(({ item }) => ({
              produto_id: item.produto_id,
              galpao_id: ctx.galpaoId,
              qty: item.qty,
              localizacao_id: item.localizacao_destino_id!,
            }))
        : null;
      const pendenciaIds = entradaDireta
        ? null
        : resp.pendencia_ids.filter((_, idx) => idxSet.has(idx));
      const printBody = linhas !== null ? { linhas } : { pendencia_ids: pendenciaIds! };
      const hasItems = (linhas?.length ?? pendenciaIds?.length ?? 0) > 0;

      if (hasItems) {
        sisoFetch("/api/wms/guarda/imprimir-lote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(printBody),
        })
          .then(async (r) => {
            if (!r.ok) {
              const body = (await r.json().catch(() => ({}))) as {
                error?: string;
              };
              toast.warning(
                `Recebimento ok, falha impressão: ${body.error ?? r.status}`,
              );
              return;
            }
            const out = (await r.json()) as {
              ok: boolean;
              totalEtiquetas?: number;
              totalFolhas?: number;
              fallbackEnvelope?: boolean;
              ignorados?: string[];
            };
            const ignoradosCount = out.ignorados?.length ?? 0;
            if (ignoradosCount > 0) {
              toast.warning(
                `${out.totalEtiquetas ?? 0} impressas, ${ignoradosCount} pendência${ignoradosCount === 1 ? "" : "s"} ignorada${ignoradosCount === 1 ? "" : "s"} (sem loc destino). Configurar em /wms/guarda.`,
                { duration: 8000 },
              );
            } else {
              toast.success(
                `${out.totalEtiquetas} etiquetas em ${out.totalFolhas} folhas${out.fallbackEnvelope ? " (impressora de envio — configure uma de produto)" : ""}`,
              );
            }
          })
          .catch((err) => {
            toast.warning(`Recebimento ok, falha impressão: ${err.message}`);
          });
      }
    }

    // Limpa form (preserva compradora/fornecedor — lotes seguidos
    // tendem a vir da mesma NF). A lista de itens é resetada dentro do
    // <ReceberLote>.
    setNf("");
    setObs("");
    setMotivo("");

    qc.invalidateQueries({ queryKey: ["wms-estoque"] });
    qc.invalidateQueries({ queryKey: ["wms-ledger"] });
    qc.invalidateQueries({ queryKey: ["wms-produtos"] });
    qc.invalidateQueries({ queryKey: ["wms-cobertura-all"] });
    qc.invalidateQueries({ queryKey: ["wms-cobertura"] });
    qc.invalidateQueries({ queryKey: ["wms-dashboard-geral"] });
    qc.invalidateQueries({ queryKey: ["wms-guarda"] });

    // Se operador quiser iniciar a rota agora, vai direto pro tablet.
    // Não faz sentido em entrada_direta (não há pendência).
    if (ctx.iniciarRota && !entradaDireta) {
      router.push(`/wms/guarda/rota?lote=${resp.lote_id}`);
    }
  }

  // 3D: fornecedor sempre obrigatório; compradora obrigatória só em NF
  // de compra. (qty/custo/loc são validados dentro do componente.)
  function validarExtra() {
    const compradoraOk = origem !== "nf_compra" || !!empresaCompradoraId;
    return !!fornecedorId && compradoraOk;
  }

  function renderLeftFormExtra() {
    return (
      <>
        <div className="wms-row-2">
          <Field label="Galpão">
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
          <Field label="Fornecedor" hint="obrigatório">
            <select
              className="wms-select"
              value={fornecedorId}
              onChange={(e) => setFornecedorId(e.target.value)}
            >
              <option value="">Escolha um fornecedor…</option>
              {fornecedores.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.nome}
                </option>
              ))}
            </select>
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

        <div className="wms-row-2">
          <Field
            label="Empresa compradora"
            hint={origem === "nf_compra" ? "obrigatório em NF de compra" : "opcional"}
          >
            <select
              className="wms-select"
              value={empresaCompradoraId}
              onChange={(e) => setEmpresaCompradoraId(e.target.value)}
            >
              <option value="">— sem compradora —</option>
              {empresas.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="NF de referência" hint="opcional">
            <input
              className="wms-input"
              value={nf}
              onChange={(e) => setNf(e.target.value)}
              placeholder="ex.: NF-7821"
            />
          </Field>
        </div>

        <div className="wms-row-2">
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
          <Field label="Motivo" hint="opcional">
            <input
              className="wms-input"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="ex.: compra antecipada"
            />
          </Field>
        </div>

        <Field label="Observações" hint="opcional">
          <input
            className="wms-input"
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            placeholder="Aplicada ao lote inteiro"
          />
        </Field>
      </>
    );
  }

  function renderSidebarFooter() {
    return (
      <button
        type="button"
        className="wms-btn wms-btn-ghost"
        style={{ marginTop: 6, width: "100%", fontSize: 12 }}
        onClick={() => router.push("/wms/guarda")}
      >
        <Icon name="arrow-right" size={11} /> Ir pra fila de guarda
      </button>
    );
  }

  return (
    <ReceberLote
      config={CONFIG_AVULSO}
      galpaoId={galpaoId}
      galpaoEditavel
      itensIniciais={itensIniciais}
      submit={submit}
      onSuccess={onSuccess}
      onError={(e) => toast.error(e.message)}
      renderLeftFormExtra={renderLeftFormExtra}
      renderSidebarFooter={renderSidebarFooter}
      validarExtra={validarExtra}
      podeReceber={podeReceber}
    />
  );
}

"use client";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { wmsApi } from "@/lib/wms/api-client";
import { useInventarioRealtime } from "@/hooks/use-inventario-realtime";
import { Icon, PageHeader, fmtNum } from "@/components/wms/ui/wms-ui";
import { ProdutoLightbox } from "@/components/wms/produto-lightbox";
import { LocVaziaModal } from "@/components/wms/inventario/loc-vazia-modal";
import { useAuth } from "@/lib/auth-context";
import type {
  ProximaLocOutput,
  EsperadoItem,
} from "@/lib/wms/inventario";

interface SessaoDetail {
  sessao?: {
    id: string;
    nome?: string;
    tipo: string;
    modo_contagem: "aberto" | "blind";
    empresa_dona_id?: string | null;
    status: string;
  };
}

interface ProdutoMin {
  id: string;
  sku: string;
  descricao?: string;
  imagem_url?: string | null;
  imagens?: string[];
}

interface ContagemLocal {
  sku: string;
  produto_id: string;
  descricao?: string;
  imagem_url?: string | null;
  imagens?: string[];
  qty: number;
  esperado?: number;
  empresa_dona_id: string | null;
}

type Etapa = "entering" | "standby" | "confirming-loc" | "counting" | "pool-vazio";

export default function ContarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { operadores } = useInventarioRealtime(id);

  const [etapa, setEtapa] = useState<Etapa>("entering");
  const [locAtual, setLocAtual] = useState<ProximaLocOutput | null>(null);
  const [contagens, setContagens] = useState<ContagemLocal[]>([]);
  const [resumoFinal, setResumoFinal] = useState<{
    locs: number;
    minutos: number;
  } | null>(null);
  const [entrouEm, setEntrouEm] = useState<number | null>(null);
  const [modalVazia, setModalVazia] = useState(false);
  const [lightbox, setLightbox] = useState<{
    imagens: string[];
    sku: string;
    descricao: string;
  } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["wms-inv", id],
    queryFn: () => wmsApi<SessaoDetail>(`/api/wms/inventario/${id}`),
  });

  const sessao = data?.sessao;
  const modoBlind = sessao?.modo_contagem === "blind";

  // Detecta se o user já está num slot
  const meuOp = user
    ? operadores.find(
        (o) => o.usuario_id === user.id && o.finalizado_em === null,
      )
    : undefined;

  // Sincroniza etapa com presença: se já entrou na party e tá em 'entering',
  // pula direto pra standby. Setado tanto pela auto-entrada quanto por usuário
  // que já estava ativo numa sessão anterior do app.
  useEffect(() => {
    if (meuOp && etapa === "entering") {
      setEtapa("standby");
      setEntrouEm(new Date(meuOp.entrou_em).getTime());
    }
  }, [meuOp, etapa]);

  // Auto-entrada: ao montar, se user não está na party ainda, entra automático.
  // useRef guard evita double-fire em React StrictMode (mount→unmount→mount em
  // dev) que aconteceria entre o disparo da mutação e a chegada do meuOp via
  // realtime. O 23505 fallback no service também cobre, mas evita toast dupla.
  const autoEntryRef = useRef(false);
  useEffect(() => {
    if (!user || meuOp || entrarParty.isPending || autoEntryRef.current) return;
    if (etapa !== "entering") return;
    autoEntryRef.current = true;
    entrarParty.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, meuOp, etapa]);

  // Auto-foco no scan quando aplicável
  useEffect(() => {
    if (etapa === "confirming-loc" || etapa === "counting") {
      scanRef.current?.focus();
    }
  }, [etapa]);

  // ─── Mutations ───
  const [retomadoFlag, setRetomadoFlag] = useState(false);

  // Limpa o selo "retomado" 5s após acender. useEffect com cleanup garante
  // que o timer é cancelado se a página desmontar antes — sem warning de
  // setState em componente desmontado.
  useEffect(() => {
    if (!retomadoFlag) return;
    const t = setTimeout(() => setRetomadoFlag(false), 5000);
    return () => clearTimeout(t);
  }, [retomadoFlag]);

  const entrarParty = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true; retomado: boolean }>(
        `/api/wms/inventario/${id}/party`,
        { method: "POST" },
      ),
    onSuccess: (r) => {
      if (r.retomado) {
        setRetomadoFlag(true);
        toast.success("Voltou pra party — contagens preservadas");
      } else {
        toast.success("Entrou na party");
      }
      setEntrouEm(Date.now());
      setEtapa("standby");
      queryClient.invalidateQueries({ queryKey: ["wms-inv", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sairParty = useMutation({
    mutationFn: () =>
      wmsApi<{ ok: true }>(`/api/wms/inventario/${id}/party`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Você saiu da party");
      router.push(`/wms/inventario/${id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pegarProxima = useMutation({
    mutationFn: () =>
      wmsApi<ProximaLocOutput>(`/api/wms/inventario/${id}/proxima-loc`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      if (r.pool_vazio) {
        const minutos = entrouEm
          ? Math.round((Date.now() - entrouEm) / 60000)
          : 0;
        setResumoFinal({
          locs: meuOp?.locs_contadas ?? 0,
          minutos,
        });
        setEtapa("pool-vazio");
        return;
      }
      setLocAtual(r);
      setContagens(
        (r.esperados ?? []).map((e: EsperadoItem) => ({
          sku: e.sku,
          produto_id: e.produto_id,
          descricao: e.descricao,
          imagem_url: e.imagem_url,
          imagens: e.imagens,
          qty: 0,
          esperado: e.saldo_esperado,
          empresa_dona_id: e.empresa_dona_id,
        })),
      );
      setEtapa("confirming-loc");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const finalizarLoc = useMutation({
    mutationFn: () => {
      if (!locAtual?.inv_loc_id)
        return Promise.reject(new Error("nenhuma loc ativa"));
      return wmsApi<{ ok: true }>(
        `/api/wms/inventario/${id}/localizacoes/${locAtual.inv_loc_id}/finalizar`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      toast.success("Localização finalizada");
      setLocAtual(null);
      setContagens([]);
      setEtapa("standby");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ─── Scan handler ───
  async function handleScan(value: string) {
    const v = value.trim();
    if (!v) return;

    // Estado confirming-loc: aceita o código da loc OU primeiro SKU
    if (etapa === "confirming-loc") {
      if (
        locAtual?.codigo &&
        v.toLowerCase() === locAtual.codigo.toLowerCase()
      ) {
        toast.success("Localização confirmada");
        setEtapa("counting");
        return;
      }
      // Não é o código da loc — assume que é produto e prossegue
      setEtapa("counting");
      await registrarBipe(v);
      return;
    }

    if (etapa === "counting") {
      await registrarBipe(v);
    }
  }

  async function registrarBipe(v: string) {
    return registrarContagemPorSku(v, 1, "incremental");
  }

  // Função genérica usada por: bipe (+1 incremental), Adicionar SKU manual (qty absoluto)
  async function registrarContagemPorSku(
    v: string,
    qty: number,
    modo: "incremental" | "absoluto",
  ) {
    if (!locAtual?.loc_id || !sessao) return;
    if (!Number.isFinite(qty) || qty < 0) {
      toast.error("Quantidade inválida");
      return;
    }

    // 1) Tenta resolver produto via esperados local — evita round-trip GET no caso quente
    const vNorm = v.trim().toUpperCase();
    const esperadoMatch = locAtual.esperados?.find(
      (e: EsperadoItem) => e.sku?.toUpperCase() === vNorm,
    );

    let produto: ProdutoMin;
    let empresaDona: string | null;

    if (esperadoMatch) {
      produto = {
        id: esperadoMatch.produto_id,
        sku: esperadoMatch.sku,
        descricao: esperadoMatch.descricao,
        imagem_url: esperadoMatch.imagem_url,
        imagens: esperadoMatch.imagens,
      };
      empresaDona =
        sessao.empresa_dona_id ?? esperadoMatch.empresa_dona_id ?? null;
    } else {
      // Fallback: produto não está nos esperados — busca no servidor
      let lookup: ProdutoMin | undefined;
      try {
        const r = await wmsApi<{ rows?: ProdutoMin[] }>(
          `/api/wms/produtos?q=${encodeURIComponent(v)}&limit=1`,
        );
        lookup = r.rows?.[0];
      } catch {
        // ignora — produto fica undefined
      }
      if (!lookup) {
        toast.error(`SKU não encontrado: ${v}`);
        return;
      }
      produto = lookup;
      empresaDona = sessao.empresa_dona_id ?? null;
    }

    if (!empresaDona) {
      toast.error(
        "Não foi possível identificar a empresa dona. Configure a sessão com empresa_dona_id.",
      );
      return;
    }

    // 2) Optimistic UI update ANTES do POST — UI responde imediatamente
    let qtyAnterior: number | null = null; // null = produto não existia na lista
    setContagens((prev) => {
      const existente = prev.find((c) => c.produto_id === produto.id);
      qtyAnterior = existente?.qty ?? null;
      if (existente) {
        return prev.map((c) =>
          c.produto_id === produto.id
            ? {
                ...c,
                qty: modo === "incremental" ? c.qty + qty : qty,
                empresa_dona_id: c.empresa_dona_id ?? empresaDona,
                imagem_url: c.imagem_url ?? produto.imagem_url ?? null,
                imagens:
                  c.imagens && c.imagens.length > 0
                    ? c.imagens
                    : produto.imagens ?? [],
              }
            : c,
        );
      }
      return [
        ...prev,
        {
          produto_id: produto.id,
          sku: produto.sku,
          descricao: produto.descricao,
          imagem_url: produto.imagem_url ?? null,
          imagens: produto.imagens ?? [],
          qty,
          empresa_dona_id: empresaDona,
        },
      ];
    });

    // 3) POST em background — reverte o otimista se falhar
    try {
      await wmsApi(`/api/wms/inventario/${id}/contagens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localizacao_id: locAtual.loc_id,
          produto_id: produto.id,
          empresa_dona_id: empresaDona,
          qty_contada: qty,
          modo,
        }),
      });
    } catch (e) {
      // Rollback robusto contra bipes em paralelo:
      //  - incremental: subtrai qty da linha atual (delta-based)
      //  - absoluto: volta pra valor anterior; remove se não existia
      setContagens((prev) => {
        const existente = prev.find((c) => c.produto_id === produto.id);
        if (!existente) return prev;
        if (modo === "incremental") {
          const novoQty = existente.qty - qty;
          if (novoQty <= 0 && qtyAnterior === null) {
            return prev.filter((c) => c.produto_id !== produto.id);
          }
          return prev.map((c) =>
            c.produto_id === produto.id
              ? { ...c, qty: Math.max(0, novoQty) }
              : c,
          );
        }
        if (qtyAnterior === null) {
          return prev.filter((c) => c.produto_id !== produto.id);
        }
        return prev.map((c) =>
          c.produto_id === produto.id ? { ...c, qty: qtyAnterior! } : c,
        );
      });
      toast.error((e as Error).message);
    }
  }

  // Edita inline a quantidade de uma linha já listada (sempre absoluto)
  async function definirQtyAbsoluta(c: ContagemLocal, novaQty: number) {
    if (!locAtual?.loc_id || !sessao) return;
    if (!Number.isFinite(novaQty) || novaQty < 0) {
      toast.error("Quantidade inválida");
      return;
    }
    if (novaQty === c.qty) return;

    const empresaDona = c.empresa_dona_id ?? sessao.empresa_dona_id ?? null;
    if (!empresaDona) {
      toast.error(
        "Não foi possível identificar a empresa dona deste SKU.",
      );
      return;
    }
    const qtyAnterior = c.qty;
    // Atualização otimista
    setContagens((prev) =>
      prev.map((x) =>
        x.produto_id === c.produto_id ? { ...x, qty: novaQty } : x,
      ),
    );
    try {
      await wmsApi(`/api/wms/inventario/${id}/contagens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localizacao_id: locAtual.loc_id,
          produto_id: c.produto_id,
          empresa_dona_id: empresaDona,
          qty_contada: novaQty,
          modo: "absoluto",
        }),
      });
    } catch (e) {
      // Reverte se a API falhar
      setContagens((prev) =>
        prev.map((x) =>
          x.produto_id === c.produto_id ? { ...x, qty: qtyAnterior } : x,
        ),
      );
      toast.error((e as Error).message);
    }
  }

  // ─── Render por etapa ───
  if (isLoading) {
    return <div className="wms-loading-pane">Carregando sessão…</div>;
  }

  if (!sessao || sessao.status === "cancelada") {
    return (
      <div className="wms-empty-block">
        <h3>Sessão indisponível</h3>
        <p>Esta sessão não pode receber contagens.</p>
      </div>
    );
  }

  // Resumo final
  if (etapa === "pool-vazio") {
    return (
      <ResumoFinal
        locsContadas={resumoFinal?.locs ?? meuOp?.locs_contadas ?? 0}
        minutos={resumoFinal?.minutos ?? 0}
        onSair={() => sairParty.mutate()}
        onVoltar={() => router.push(`/wms/inventario/${id}`)}
      />
    );
  }

  // Entrando na party
  if (etapa === "entering") {
    return (
      <div className="wms-loading-pane">
        {entrarParty.isPending ? "Entrando na party…" : "Aguardando…"}
      </div>
    );
  }

  // Standby / confirming / counting — header comum
  return (
    <>
      <PageHeader
        title={sessao.nome ?? `Sessão ${id.slice(0, 8)}`}
        subtitle={`${user?.nome ?? "Você"} na party · ${
          modoBlind ? "blind" : "aberto"
        }${retomadoFlag ? " · ↻ retomado" : ""}`}
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost wms-btn-sm"
          onClick={() => {
            if (
              confirm(
                "Sair da party? Locs em contagem ficam liberadas pra cleanup.",
              )
            ) {
              sairParty.mutate();
            }
          }}
        >
          Sair da party
        </button>
      </PageHeader>

      {etapa === "standby" && (
        <StandbyView
          locsContadas={meuOp?.locs_contadas ?? 0}
          onPegarProxima={() => pegarProxima.mutate()}
          pending={pegarProxima.isPending}
        />
      )}

      {(etapa === "confirming-loc" || etapa === "counting") && locAtual && (
        <CounterView
          loc={locAtual}
          contagens={contagens}
          confirmingLoc={etapa === "confirming-loc"}
          modoBlind={modoBlind}
          scanRef={scanRef}
          onScan={handleScan}
          onConfirmar={() => setEtapa("counting")}
          onFinalizar={() => {
            if (contagens.length === 0) {
              setModalVazia(true);
            } else {
              finalizarLoc.mutate();
            }
          }}
          finalizando={finalizarLoc.isPending}
          onAdicionarSku={(sku, qty) =>
            registrarContagemPorSku(sku, qty, "absoluto")
          }
          onDefinirQty={(c, q) => definirQtyAbsoluta(c, q)}
          onImageClick={(c) => {
            const imgs =
              c.imagens && c.imagens.length > 0
                ? c.imagens
                : c.imagem_url
                  ? [c.imagem_url]
                  : [];
            if (imgs.length > 0) {
              setLightbox({
                imagens: imgs,
                sku: c.sku,
                descricao: c.descricao ?? "",
              });
            }
          }}
        />
      )}

      {lightbox && (
        <ProdutoLightbox
          imagens={lightbox.imagens}
          sku={lightbox.sku}
          descricao={lightbox.descricao}
          onClose={() => setLightbox(null)}
        />
      )}

      {modalVazia && locAtual && locAtual.codigo && (
        <LocVaziaModal
          locCodigo={locAtual.codigo}
          loading={finalizarLoc.isPending}
          onConfirmar={() => {
            setModalVazia(false);
            finalizarLoc.mutate();
          }}
          onCancelar={() => setModalVazia(false)}
        />
      )}
    </>
  );
}

function StandbyView({
  locsContadas,
  onPegarProxima,
  pending,
}: {
  locsContadas: number;
  onPegarProxima: () => void;
  pending: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 24,
        padding: "32px 16px",
      }}
    >
      <div className="wms-td-mute" style={{ fontSize: 14 }}>
        {locsContadas === 0
          ? "Pronto pra começar?"
          : `Você já contou ${locsContadas} loc(s)`}
      </div>
      <button
        type="button"
        className="wms-btn wms-btn-primary"
        disabled={pending}
        onClick={onPegarProxima}
        style={{
          fontSize: 18,
          padding: "20px 32px",
          minHeight: 80,
          minWidth: 280,
        }}
      >
        <Icon name="arrow-right" size={18} />
        {pending ? "Buscando…" : "PEGAR PRÓXIMA LOCALIZAÇÃO"}
      </button>
      <div className="wms-td-mute" style={{ fontSize: 12, textAlign: "center" }}>
        O sistema vai te direcionar pra loc mais próxima da última
        <br />e longe dos outros operadores.
      </div>
    </div>
  );
}

function CounterView({
  loc,
  contagens,
  confirmingLoc,
  modoBlind,
  scanRef,
  onScan,
  onConfirmar,
  onFinalizar,
  finalizando,
  onAdicionarSku,
  onDefinirQty,
  onImageClick,
}: {
  loc: ProximaLocOutput;
  contagens: ContagemLocal[];
  confirmingLoc: boolean;
  modoBlind: boolean;
  scanRef: React.RefObject<HTMLInputElement | null>;
  onScan: (v: string) => void;
  onConfirmar: () => void;
  onFinalizar: () => void;
  finalizando: boolean;
  onAdicionarSku: (sku: string, qty: number) => Promise<void> | void;
  onDefinirQty: (c: ContagemLocal, novaQty: number) => Promise<void> | void;
  onImageClick: (c: ContagemLocal) => void;
}) {
  const totalContado = useMemo(
    () => contagens.reduce((acc, c) => acc + c.qty, 0),
    [contagens],
  );

  return (
    <>
      {/* Header da loc atual */}
      <div
        style={{
          background: confirmingLoc
            ? "var(--wms-c-warning-bg, #fef3c7)"
            : "var(--wms-c-faint)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: "var(--wms-r-3)",
          padding: 18,
          marginBottom: 14,
          textAlign: "center",
        }}
      >
        <div
          className="wms-td-mute"
          style={{ fontSize: 11, marginBottom: 4, letterSpacing: 1 }}
        >
          {confirmingLoc ? "VÁ ATÉ A LOCALIZAÇÃO" : "CONTANDO"}
        </div>
        <div
          className="wms-mono"
          style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}
        >
          {loc.codigo}
        </div>
        {loc.zona && (
          <div className="wms-td-mute" style={{ fontSize: 12, marginTop: 4 }}>
            zona {loc.zona} · {loc.tipo}
          </div>
        )}
        {loc.claim_tipo && loc.claim_codigo && (
          <div
            className="wms-mono"
            style={{
              fontSize: 11,
              marginTop: 4,
              color:
                loc.claim_tipo === "colisao"
                  ? "var(--wms-c-warn, #b76f0e)"
                  : "var(--wms-c-fg-2)",
            }}
          >
            {loc.claim_tipo === "rua" && `rua ${loc.claim_codigo} ↓`}
            {loc.claim_tipo === "predio" && `prédio ${loc.claim_codigo} ↓`}
            {loc.claim_tipo === "colisao" &&
              `prédio ${loc.claim_codigo} ↑ (compartilhando)`}
          </div>
        )}
      </div>

      {confirmingLoc && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 14,
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <strong>Bipe o QR ou digite o código da localização</strong> pra
            confirmar.
            <br />
            Se a loc não tem etiqueta, clique abaixo.
          </div>
          <button
            type="button"
            className="wms-btn wms-btn-ghost wms-btn-sm"
            onClick={() => {
              if (
                confirm(
                  `Confirmar que você está em ${loc.codigo} sem ler etiqueta?`,
                )
              ) {
                onConfirmar();
              }
            }}
          >
            Loc sem etiqueta — confirmar mesmo assim
          </button>
        </div>
      )}

      {/* Scan input */}
      <input
        ref={scanRef}
        placeholder={
          confirmingLoc
            ? "bipe o QR ou digite o código da localização"
            : "bipe SKU ou GTIN do produto"
        }
        onKeyDown={(e) => {
          const target = e.target as HTMLInputElement;
          if (e.key === "Enter" && target.value) {
            onScan(target.value);
            target.value = "";
          }
        }}
        className="w-full rounded-xl border-2 border-line bg-paper px-3 py-3 font-mono text-lg text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none"
        style={{ marginBottom: 16 }}
      />

      {/* Adicionar SKU manualmente — só na fase de contagem */}
      {!confirmingLoc && (
        <AddSkuManual onAdicionar={onAdicionarSku} />
      )}

      {/* Lista de contagens */}
      <h3 className="wms-sec-h">
        Contagens nesta loc · {fmtNum(totalContado)} item(s)
      </h3>
      {contagens.length === 0 ? (
        <div className="wms-exp-empty">
          {confirmingLoc
            ? "Confirme a loc e comece a bipar."
            : "Bipe os produtos ou adicione manualmente."}
        </div>
      ) : (
        <div className="wms-tbl">
          <table>
            <thead>
              <tr>
                <th style={{ width: 64 }}></th>
                <th>SKU</th>
                <th>Descrição</th>
                <th className="wms-tar" style={{ width: 110 }}>
                  Bipado
                </th>
                {!modoBlind && <th className="wms-tar">Esperado</th>}
              </tr>
            </thead>
            <tbody>
              {contagens.map((c) => (
                <tr key={c.produto_id}>
                  <td>
                    {c.imagem_url && (
                      <img
                        src={c.imagem_url}
                        alt=""
                        loading="lazy"
                        className="wms-thumb wms-thumb-md wms-thumb-click"
                        onClick={() => onImageClick(c)}
                      />
                    )}
                  </td>
                  <td className="wms-mono">{c.sku}</td>
                  <td className="wms-td-mute" style={{ fontSize: 12 }}>
                    {c.descricao ?? "—"}
                  </td>
                  <td className="wms-tar">
                    {confirmingLoc ? (
                      <span className="wms-mono">{fmtNum(c.qty)}</span>
                    ) : (
                      <EditableQty
                        value={c.qty}
                        onCommit={(n) => onDefinirQty(c, n)}
                      />
                    )}
                  </td>
                  {!modoBlind && (
                    <td className="wms-tar wms-mono wms-td-mute">
                      {c.esperado !== undefined ? fmtNum(c.esperado) : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Botão finalizar */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: 20,
          paddingTop: 14,
          borderTop: "1px solid var(--wms-c-border)",
        }}
      >
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          disabled={confirmingLoc || finalizando}
          onClick={onFinalizar}
        >
          <Icon name="check" size={11} />
          {finalizando ? "Finalizando…" : "FINALIZAR LOCALIZAÇÃO"}
        </button>
      </div>
    </>
  );
}

function ResumoFinal({
  locsContadas,
  minutos,
  onSair,
  onVoltar,
}: {
  locsContadas: number;
  minutos: number;
  onSair: () => void;
  onVoltar: () => void;
}) {
  const velocidade = minutos > 0 ? Math.round((locsContadas / minutos) * 60) : 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
        padding: "48px 16px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 56 }}>🎉</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>Você terminou!</div>
      <div className="wms-td-mute" style={{ maxWidth: 360 }}>
        O pool de localizações foi esvaziado. Obrigado pela contagem.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginTop: 12,
          width: "100%",
          maxWidth: 480,
        }}
      >
        <Kpi label="Locs contadas" value={locsContadas} />
        <Kpi
          label="Tempo"
          value={
            minutos < 60
              ? `${minutos}min`
              : `${Math.floor(minutos / 60)}h ${minutos % 60}min`
          }
        />
        <Kpi label="Velocidade" value={`${velocidade} locs/h`} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={onSair}
        >
          Sair da party
        </button>
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={onVoltar}
        >
          Ver painel
        </button>
      </div>
    </div>
  );
}

// Input editável de quantidade — commit no blur ou Enter, revert no Escape
function EditableQty({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => Promise<void> | void;
}) {
  const [val, setVal] = useState<string>(String(value));
  // Mantém o input sincronizado se o valor mudar de fora (ex: bipe extra)
  useEffect(() => {
    setVal(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) {
      setVal(String(value));
      return;
    }
    if (n === value) return;
    onCommit(n);
  };

  return (
    <input
      type="number"
      min={0}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setVal(String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="wms-mono"
      style={{
        width: 72,
        textAlign: "right",
        background: "transparent",
        border: "1px solid var(--wms-c-border)",
        borderRadius: 4,
        padding: "3px 6px",
        fontSize: 13,
      }}
    />
  );
}

// Formulário inline pra adicionar SKU manualmente (define qty absoluta)
function AddSkuManual({
  onAdicionar,
}: {
  onAdicionar: (sku: string, qty: number) => Promise<void> | void;
}) {
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);

  const valid =
    sku.trim().length > 0 && Number.isFinite(Number(qty)) && Number(qty) > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onAdicionar(sku.trim(), Number(qty));
      setSku("");
      setQty("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        marginBottom: 16,
        padding: 10,
        border: "1px dashed var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        background: "var(--wms-c-faint)",
      }}
    >
      <span className="wms-td-mute" style={{ fontSize: 12, marginRight: 4 }}>
        Adicionar manualmente:
      </span>
      <input
        type="text"
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="SKU ou GTIN"
        className="wms-mono"
        style={{
          flex: 1,
          minWidth: 0,
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: 4,
          padding: "6px 8px",
          fontSize: 13,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <input
        type="number"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        placeholder="qty"
        min={1}
        className="wms-mono"
        style={{
          width: 80,
          background: "var(--wms-c-panel)",
          border: "1px solid var(--wms-c-border)",
          borderRadius: 4,
          padding: "6px 8px",
          fontSize: 13,
          textAlign: "right",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button
        type="button"
        className="wms-btn wms-btn-ghost wms-btn-sm"
        disabled={!valid || busy}
        onClick={submit}
      >
        <Icon name="plus" size={11} />
        {busy ? "…" : "Adicionar"}
      </button>
    </div>
  );
}

// Kpi local pra não importar de wms-ui inline
function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        border: "1px solid var(--wms-c-border)",
        borderRadius: "var(--wms-r-3)",
        padding: 10,
        textAlign: "center",
      }}
    >
      <div
        className="wms-td-mute"
        style={{ fontSize: 11, letterSpacing: 0.5 }}
      >
        {label}
      </div>
      <div className="wms-mono" style={{ fontSize: 18, fontWeight: 700 }}>
        {value}
      </div>
    </div>
  );
}

"use client";

import { Suspense, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch, useAuth, usePermissoes } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { PageHeader, Field, Icon } from "@/components/wms/ui/wms-ui";
import {
  ProdutoCombo,
  useGalpoes,
  type EmpresaLite,
  type GalpaoLite,
} from "@/components/wms/ui/modals";
import type { Produto } from "@/lib/wms/types";
import type {
  CriarVendaDiretaRequest,
  CriarVendaDiretaResponse,
  ModoVendaDireta,
} from "@/types";
import {
  agregarSolicitacaoPorProduto,
  produtoTemCobertura,
} from "@/lib/wms/vendas-cobertura";

interface VendedorLite {
  id: string;
  nome: string;
}

const CANAIS = ["Balcão", "WhatsApp", "Telefone", "Outro"];

interface ItemForm {
  uid: string;
  produto: Produto | null;
  quantidade: number;
}

// Plano ledger simplificado 3D (2026-05-20): estoque fungível dentro do galpão.
// API /disponibilidade não devolve mais empresa_dona — só loc + qty.
interface DisponibilidadeResp {
  total_disponivel: number;
  sugestao: {
    localizacao_id: string;
    localizacao_codigo: string;
    localizacao_tipo: string;
    disponivel: number;
  } | null;
}

function emptyItem(): ItemForm {
  return {
    uid: crypto.randomUUID(),
    produto: null,
    quantidade: 1,
  };
}

export default function NovaVendaPage() {
  return (
    <Suspense fallback={<div className="wms-sales-detail-loading"><span /><span /></div>}>
      <NovaVendaBody />
    </Suspense>
  );
}

function NovaVendaBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { can, permissoes } = usePermissoes();
  const podeCriar = can("vendas.criar");
  // Permission gate scaffold pra "criar em nome de X" (finding 5.28).
  // A permissão `vendas.criar_em_nome_de` será adicionada pelo P4. Checa
  // direto no Set (em vez de can(...)) pra contornar o tipo restrito
  // PermissaoCodigo. Hoje retorna false sempre — UI fica oculta.
  const podeCriarEmNomeDe = permissoes.has("vendas.criar_em_nome_de");
  const { data: galpoes } = useGalpoes();

  // Vendedores disponíveis pra atribuir o pedido. Só carrega quando o
  // operador tem `vendas.criar_em_nome_de` (P4). Endpoint atual exige
  // sistema.usuarios; P4 deve expor um endpoint mais leve.
  const vendedoresQuery = useQuery({
    queryKey: ["wms-vendedores-lite"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/admin/usuarios");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = (await r.json()) as Array<{
        id: string;
        nome: string;
        ativo: boolean;
        cargos?: string[];
      }>;
      return list
        .filter((u) => u.ativo && (u.cargos ?? []).includes("vendedor"))
        .map((u) => ({ id: u.id, nome: u.nome }) satisfies VendedorLite);
    },
    enabled: podeCriarEmNomeDe,
    staleTime: 60_000,
  });

  const empresas = useMemo<EmpresaLite[]>(
    () =>
      (galpoes ?? []).flatMap((g: GalpaoLite) =>
        g.empresas.map((e) => ({ ...e, galpao_id: g.id })),
      ),
    [galpoes],
  );

  // Full: envio de estoque ao CDF do ML, sem pedido-fantasma no Tiny. Esconde
  // cliente/CPF/canal (não se aplica); força modo="separacao" (Full nunca faz
  // baixa_direta — reconciliação de estoque é sempre via editor da lane Full).
  const [isFull, setIsFull] = useState(searchParams.get("tipo") === "full");
  // Full: "Separar na ordem da lista" — preserva cada linha como digitada
  // (2 linhas do mesmo SKU = 2 itens no checklist, espelhando a lista do
  // envio Full do ML). Desligado = duplicatas somadas numa linha só.
  const [preservarLinhas, setPreservarLinhas] = useState(false);
  const [clienteNome, setClienteNome] = useState("");
  const [clienteCpf, setClienteCpf] = useState("");
  const [canal, setCanal] = useState("Balcão");
  const [empresaOrigemId, setEmpresaOrigemId] = useState("");
  const [galpaoId, setGalpaoId] = useState("");
  const [modo, setModo] = useState<ModoVendaDireta>("separacao");
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [enviando, setEnviando] = useState(false);
  // Override do vendedor (P4 gate — finding 5.28). null = usa o operador
  // logado (comportamento padrão). Quando setado, o pedido fica em nome
  // do vendedor escolhido. Backend consome `vendedor_id_alvo` (commit
  // 89577b5) — frontend re-aligned no re-audit fix #7.NEW2.
  const [vendedorIdAlvo, setVendedorIdAlvo] = useState<string | null>(
    null,
  );

  const addItem = () => setItems((arr) => [...arr, emptyItem()]);
  const updateItem = (idx: number, patch: Partial<ItemForm>) =>
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeItem = (idx: number) =>
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));

  // Resolve disponibilidade por item (paralelo, cacheado por React Query).
  // Em 3D, estoque é fungível dentro do galpão — empresa_origem_id não
  // influencia a sugestão, então fica fora do query key.
  const dispQueries = useQueries({
    queries: items.map((it) => ({
      queryKey: [
        "wms-vendas-disponibilidade",
        it.produto?.id,
        galpaoId,
      ],
      queryFn: () => {
        const sp = new URLSearchParams({
          produto_id: it.produto!.id,
          galpao_id: galpaoId,
        });
        return wmsApi<DisponibilidadeResp>(
          `/api/wms/vendas/disponibilidade?${sp.toString()}`,
        );
      },
      enabled: !!(it.produto?.id && galpaoId),
      staleTime: 15 * 1000,
    })),
  });

  const valido =
    (isFull || !!clienteNome.trim()) &&
    !!empresaOrigemId &&
    !!galpaoId &&
    items.every((it) => !!it.produto && it.quantidade > 0);

  const submitFull = async () => {
    const payload = {
      empresa_origem_id: empresaOrigemId,
      galpao_id: galpaoId,
      items: items.map((it) => ({
        produto_id: it.produto!.id,
        quantidade: it.quantidade,
      })),
      idempotency_key: crypto.randomUUID(),
      ...(preservarLinhas ? { preservar_linhas: true } : {}),
    };

    const res = await sisoFetch("/api/wms/full/criar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { erro?: string };
      toast.error(err.erro ?? "Erro ao criar Full");
      return;
    }

    const data = (await res.json()) as {
      pedido_id: string;
      numero: string;
      parcial?: boolean;
      itens_parciais?: Array<{
        sku: string;
        quantidade_pedida: number;
        quantidade_reservada: number;
      }>;
    };
    if (data.parcial) {
      const detalhe = (data.itens_parciais ?? [])
        .map((i) => `${i.sku} (${i.quantidade_reservada}/${i.quantidade_pedida})`)
        .join(", ");
      toast.warning(`Full ${data.numero} criado com reserva parcial: ${detalhe}`, {
        duration: 10000,
      });
    } else {
      toast.success(`Full ${data.numero} criado e mandado pra separação`);
    }
    router.push("/wms/separacao-full");
  };

  const submit = async () => {
    if (!valido || enviando) return;
    setEnviando(true);
    try {
      if (isFull) {
        await submitFull();
        return;
      }

      const payload: CriarVendaDiretaRequest & {
        vendedor_id_alvo?: string;
      } = {
        cliente_nome: clienteNome.trim(),
        cliente_cpf_cnpj: clienteCpf.trim() || null,
        canal_venda: canal,
        empresa_origem_id: empresaOrigemId,
        galpao_id: galpaoId,
        modo,
        items: items.map((it) => ({
          produto_id: it.produto!.id,
          quantidade: it.quantidade,
        })),
        idempotency_key: crypto.randomUUID(),
      };
      // P4 scaffold: envia override quando o operador tem a permissão.
      // Backend ainda ignora hoje (gravando user.id) — P4 vai consumir.
      if (podeCriarEmNomeDe && vendedorIdAlvo) {
        payload.vendedor_id_alvo = vendedorIdAlvo;
      }

      const res = await sisoFetch("/api/wms/vendas/criar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          erro?: string;
          codigo?: string;
          sku?: string;
          empresas_disponiveis?: Array<{ id: string; nome: string }>;
        };
        // [Fix-D #7.8] Surface payload estruturado pra PRODUTO_NAO_MAPEADO
        if (res.status === 400 && err.codigo === "PRODUTO_NAO_MAPEADO") {
          const empresasMsg =
            err.empresas_disponiveis && err.empresas_disponiveis.length > 0
              ? ` Disponível em: ${err.empresas_disponiveis.map((e) => e.nome).join(", ")}.`
              : "";
          toast.error(
            `Produto ${err.sku ?? ""} não cadastrado nessa empresa.${empresasMsg}`,
            { duration: 8000 },
          );
          return;
        }
        toast.error(err.erro ?? "Erro ao criar pedido");
        return;
      }

      const data = (await res.json()) as CriarVendaDiretaResponse;
      if (data.degradado && data.motivo_degradacao === "falta_saldo") {
        const skus = (data.skus_sem_saldo ?? []).join(", ") || "—";
        toast.warning(
          `Pedido ${data.numero} criado, mas vai pra separação: sem saldo de ${skus}.`,
          { duration: 10000 },
        );
      } else if (modo === "baixa_direta") {
        toast.success(`Pedido ${data.numero} criado e baixado do estoque`);
      } else {
        toast.success(`Pedido ${data.numero} criado e mandado pra separação`);
      }
      router.push(`/wms/vendas/${encodeURIComponent(data.pedido_id)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar pedido");
    } finally {
      setEnviando(false);
    }
  };

  const totalUnidades = items.reduce(
    (total, item) => total + Math.max(0, Number(item.quantidade) || 0),
    0,
  );
  const solicitacaoPorProduto = useMemo(
    () =>
      agregarSolicitacaoPorProduto(
        items.map((item) => ({
          produtoId: item.produto?.id ?? null,
          quantidade: item.quantidade,
        })),
      ),
    [items],
  );
  const itensPreenchidos = items.filter((item) => item.produto).length;
  const itensComSaldo = items.filter((item, index) => {
    if (!item.produto || !galpaoId) return false;
    return produtoTemCobertura(
      solicitacaoPorProduto.get(item.produto.id),
      Number(dispQueries[index]?.data?.total_disponivel ?? 0),
    );
  }).length;
  const itensSemCobertura = items.filter((item, index) => {
    if (
      !item.produto ||
      !galpaoId ||
      dispQueries[index]?.isFetching ||
      dispQueries[index]?.isError
    ) {
      return false;
    }
    return !produtoTemCobertura(
      solicitacaoPorProduto.get(item.produto.id),
      Number(dispQueries[index]?.data?.total_disponivel ?? 0),
    );
  }).length;
  const coberturaEmConsulta = items.some(
    (item, index) =>
      !!item.produto && !!galpaoId && !!dispQueries[index]?.isFetching,
  );
  const coberturaComErro = items.some(
    (item, index) =>
      !!item.produto && !!galpaoId && !!dispQueries[index]?.isError,
  );
  const coberturaConferida =
    itensPreenchidos > 0 &&
    itensComSaldo === itensPreenchidos &&
    !coberturaEmConsulta &&
    !coberturaComErro;

  return (
    <>
      <PageHeader
        title={isFull ? "Novo envio Full" : "Nova venda"}
        subtitle={
          isFull
            ? "Monte as linhas do envio e confira a cobertura antes de liberar para separação."
            : "Cadastre o cliente, escolha a saída e acompanhe cada item desde a origem."
        }
        backHref="/wms/vendas"
        backLabel="Vendas diretas"
      >
        <span className={`wms-sales-origin ${isFull ? "is-full" : ""}`}>
          {isFull ? "FULL" : "MANUAL"}
        </span>
      </PageHeader>

      <div className="wms-sales-create">
        <main className="wms-sales-create-main">

      {/* Tipo de pedido — Full esconde cliente/CPF/canal e envia ao CDF do ML
          sem pedido-fantasma no Tiny (ver /wms/separacao-full). */}
      <section className="wms-card wms-sales-create-section">
        <div className="wms-sales-create-section-head">
          <span>01 · Fluxo</span>
          <h2>O que você está criando?</h2>
        </div>
        <Field label="Tipo de pedido">
          <div className="wms-sales-type-options">
            <button
              type="button"
              onClick={() => setIsFull(false)}
              className={`wms-sales-type-option ${!isFull ? "is-active" : ""}`}
            >
              <span><Icon name="handshake" size={16} /></span>
              <strong>Venda direta</strong>
              <small>Cliente, canal e baixa direta ou separação.</small>
              {!isFull && <Icon name="check" size={13} />}
            </button>
            <button
              type="button"
              onClick={() => setIsFull(true)}
              className={`wms-sales-type-option ${isFull ? "is-active" : ""}`}
            >
              <span><Icon name="box" size={16} /></span>
              <strong>Envio Full</strong>
              <small>Estoque para o CDF do Mercado Livre, por linha.</small>
              {isFull && <Icon name="check" size={13} />}
            </button>
          </div>
          {isFull && (
            <label className="wms-sales-preserve-lines">
              <input
                type="checkbox"
                checked={preservarLinhas}
                onChange={(e) => setPreservarLinhas(e.target.checked)}
              />
              <span>
                Separar na ordem da lista
                <small>
                  Mantém cada linha como digitada — o mesmo SKU em 2 linhas vira 2 itens
                  no checklist, na ordem da lista do envio Full.
                </small>
              </span>
            </label>
          )}
        </Field>
      </section>

      {/* Cliente + canal */}
      <section className="wms-card wms-sales-create-section">
        <div className="wms-sales-create-section-head">
          <span>02 · Contexto</span>
          <h2>{isFull ? "Origem do envio" : "Cliente e origem da venda"}</h2>
        </div>
        {!isFull && (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
            <Field label="Cliente" required>
              <input
                value={clienteNome}
                onChange={(e) => setClienteNome(e.target.value)}
                className="wms-input"
                placeholder="Nome do cliente"
              />
            </Field>
            <Field label="CPF/CNPJ">
              <input
                value={clienteCpf}
                onChange={(e) => setClienteCpf(e.target.value)}
                className="wms-input"
                placeholder="Opcional"
              />
            </Field>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isFull ? "1fr 1fr" : "1fr 1.5fr 1fr",
            gap: 10,
          }}
        >
          {!isFull && (
            <Field label="Canal">
              <select
                value={canal}
                onChange={(e) => setCanal(e.target.value)}
                className="wms-input"
              >
                {CANAIS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={isFull ? "Conta ML" : "Empresa que vende"} required>
            <select
              value={empresaOrigemId}
              onChange={(e) => setEmpresaOrigemId(e.target.value)}
              className="wms-input"
            >
              <option value="">Selecione…</option>
              {empresas.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Galpão" required>
            <select
              value={galpaoId}
              onChange={(e) => setGalpaoId(e.target.value)}
              className="wms-input"
            >
              <option value="">Selecione…</option>
              {(galpoes ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* "Criar em nome de X" — gate por permissão vendas.criar_em_nome_de
            (P4). Hoje renderiza zero porque a perm não existe; quando P4
            adicionar, esta seção fica visível pra admins/operadores. */}
        {podeCriarEmNomeDe && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
            <Field label="Criar em nome de">
              <select
                value={vendedorIdAlvo ?? ""}
                onChange={(e) =>
                  setVendedorIdAlvo(e.target.value || null)
                }
                className="wms-input"
                disabled={vendedoresQuery.isLoading || vendedoresQuery.isError}
              >
                <option value="">
                  Eu mesmo ({user?.nome ?? "—"})
                </option>
                {(vendedoresQuery.data ?? [])
                  .filter((v) => v.id !== user?.id)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nome}
                    </option>
                  ))}
              </select>
              <p className="wms-td-mute" style={{ fontSize: 11, marginTop: 4 }}>
                {vendedorIdAlvo
                  ? "Pedido será criado em nome do vendedor selecionado."
                  : "Pedido será atribuído a você."}
              </p>
            </Field>
          </div>
        )}
      </section>

      {/* Modo — Full não se aplica (sempre separação; editor da lane Full é
          quem reconcilia estoque, nunca baixa_direta). */}
      {!isFull && (
        <section className="wms-card wms-sales-create-section">
          <div className="wms-sales-create-section-head">
            <span>03 · Saída</span>
            <h2>Como o estoque será processado?</h2>
          </div>
          <Field label="Como baixar do estoque">
            <div className="wms-sales-mode-options">
              <button
                type="button"
                onClick={() => setModo("separacao")}
                className={`wms-sales-mode-option ${modo === "separacao" ? "is-active" : ""}`}
              >
                <Icon name="list" size={14} />
                <span>
                  <strong>Mandar para separação</strong>
                  <small>Operador retira, confere e embala.</small>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setModo("baixa_direta")}
                className={`wms-sales-mode-option ${modo === "baixa_direta" ? "is-active" : ""}`}
              >
                <Icon name="arrow-right" size={14} />
                <span>
                  <strong>Baixa direta</strong>
                  <small>Registra a saída agora, sem fila de picking.</small>
                </span>
              </button>
            </div>
            {modo === "baixa_direta" && (
              <p className="wms-sales-mode-note">
                Se algum item não tiver cobertura completa, o pedido muda
                automaticamente para separação e mantém a rastreabilidade.
              </p>
            )}
          </Field>
        </section>
      )}

      {/* Itens — overflow visible pra não clipar dropdown do ProdutoCombo */}
      <section className="wms-card wms-sales-create-section wms-sales-create-items">
        <div className="wms-sales-create-section-head">
          <span>{isFull ? "03" : "04"} · Itens</span>
          <h2>{isFull ? "Linhas do envio Full" : "Produtos da venda"}</h2>
          <small>
            {itensPreenchidos}/{items.length} linhas preenchidas ·{" "}
            {totalUnidades.toLocaleString("pt-BR")} unidades
          </small>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {items.map((item, idx) => {
            const disp = dispQueries[idx];
            const sug = disp?.data?.sugestao ?? null;
            const total = disp?.data?.total_disponivel ?? 0;
            const carregando = !!disp?.isFetching && !disp?.data;
            const erroDisponibilidade = !!disp?.isError;
            const solicitacaoProduto = item.produto
              ? solicitacaoPorProduto.get(item.produto.id)
              : undefined;
            const podeBaixar =
              !!item.produto &&
              produtoTemCobertura(solicitacaoProduto, total);
            const semSaldo =
              !!item.produto &&
              !!galpaoId &&
              !carregando &&
              !erroDisponibilidade &&
              total === 0;
            const saldoInsuficiente =
              !!item.produto &&
              !!galpaoId &&
              !carregando &&
              !erroDisponibilidade &&
              total > 0 &&
              !podeBaixar;
            return (
              <div
                key={item.uid}
                className={`wms-sales-create-item ${
                  saldoInsuficiente || semSaldo ? "has-warning" : ""
                }`}
              >
                <div
                  className="wms-sales-create-item-fields"
                >
                  <span className="wms-sales-create-line">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <ProdutoCombo
                    value={item.produto}
                    onChange={(p) => updateItem(idx, { produto: p })}
                  />
                  <input
                    type="number"
                    min={1}
                    value={item.quantidade}
                    onChange={(e) =>
                      updateItem(idx, {
                        quantidade: parseInt(e.target.value, 10) || 0,
                      })
                    }
                    className="wms-input"
                    placeholder="Qty"
                  />
                  <button
                    type="button"
                    className="wms-btn-icon"
                    onClick={() => removeItem(idx)}
                    disabled={items.length === 1}
                    aria-label="Remover item"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>

                {/* Linha de disponibilidade — read-only, automática */}
                {item.produto && galpaoId && (
                  <div
                    className="wms-sales-create-availability"
                  >
                    <Icon name="sparkle" size={11} />
                    {carregando ? (
                      <span className="wms-td-mute">
                        Buscando localização…
                      </span>
                    ) : erroDisponibilidade ? (
                      <span
                        style={{
                          color: "var(--wms-c-warning, #d97706)",
                        }}
                      >
                        Não foi possível consultar o saldo agora
                      </span>
                    ) : sug ? (
                      <>
                        <span>
                          Loc sugerida:{" "}
                          <strong>{sug.localizacao_codigo}</strong>
                          {sug.localizacao_tipo === "picking" ? " (picking)" : ""}
                        </span>
                        <span className="wms-td-mute">·</span>
                        <span
                          style={{
                            color: podeBaixar
                              ? "var(--wms-c-success, #16a34a)"
                              : saldoInsuficiente
                                ? "var(--wms-c-warning, #d97706)"
                                : "var(--wms-c-danger, #dc2626)",
                            fontWeight: 500,
                          }}
                        >
                          {total} disponíve{total === 1 ? "l" : "is"} no galpão
                        </span>
                        {saldoInsuficiente && (
                          <span
                            className="wms-td-mute"
                            style={{ fontSize: 11 }}
                          >
                            — pedindo {solicitacaoProduto?.quantidade ?? item.quantidade}
                            {solicitacaoProduto && solicitacaoProduto.linhas > 1
                              ? ` em ${solicitacaoProduto.linhas} linhas`
                              : ""}
                            , vira separação/OC
                          </span>
                        )}
                      </>
                    ) : semSaldo ? (
                      <span
                        style={{
                          color: "var(--wms-c-danger, #dc2626)",
                        }}
                      >
                        Sem saldo no galpão — vira separação/OC ao criar
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Botão fica embaixo da lista pra seguir o crescimento — o operador
            não precisa mais subir até o topo a cada SKU adicionado. */}
        <button
          className="wms-btn"
          onClick={addItem}
          type="button"
          style={{ width: "100%", marginTop: 10 }}
        >
          <Icon name="plus" size={11} /> Adicionar item
        </button>
      </section>

        </main>

        <aside className="wms-sales-create-summary">
          <header>
            <span>Resumo</span>
            <h2>{isFull ? "Envio Full" : "Venda direta"}</h2>
            <p>
              Revise os pontos abaixo antes de criar. Nada será movimentado
              enquanto você não confirmar.
            </p>
          </header>

          <dl>
            <div>
              <dt>Responsável</dt>
              <dd>
                {vendedorIdAlvo
                  ? vendedoresQuery.data?.find((v) => v.id === vendedorIdAlvo)
                      ?.nome ?? "Vendedor selecionado"
                  : user?.nome ?? "—"}
              </dd>
            </div>
            <div>
              <dt>{isFull ? "Conta ML" : "Empresa"}</dt>
              <dd>
                {empresas.find((empresa) => empresa.id === empresaOrigemId)
                  ?.nome ?? "Pendente"}
              </dd>
            </div>
            <div>
              <dt>Galpão</dt>
              <dd>
                {(galpoes ?? []).find((galpao) => galpao.id === galpaoId)
                  ?.nome ?? "Pendente"}
              </dd>
            </div>
            <div>
              <dt>Itens / unidades</dt>
              <dd>
                {itensPreenchidos} / {totalUnidades.toLocaleString("pt-BR")}
              </dd>
            </div>
          </dl>

          <div className="wms-sales-create-checks">
            <span className={empresaOrigemId && galpaoId ? "is-ok" : ""}>
              <Icon
                name={empresaOrigemId && galpaoId ? "check" : "dot"}
                size={11}
              />
              Origem definida
            </span>
            <span className={itensPreenchidos === items.length ? "is-ok" : ""}>
              <Icon
                name={itensPreenchidos === items.length ? "check" : "dot"}
                size={11}
              />
              Todas as linhas preenchidas
            </span>
            <span
              className={
                coberturaConferida
                  ? "is-ok"
                  : itensSemCobertura > 0 || coberturaComErro
                    ? "is-warning"
                    : ""
              }
            >
              <Icon
                name={
                  itensSemCobertura > 0 || coberturaComErro
                    ? "alert"
                    : coberturaConferida
                      ? "check"
                      : "dot"
                }
                size={11}
              />
              {coberturaComErro
                ? "Falha ao conferir cobertura"
                : itensSemCobertura > 0
                ? `${itensSemCobertura} ${
                    itensSemCobertura === 1 ? "item sem" : "itens sem"
                  } cobertura`
                : coberturaConferida
                  ? "Cobertura conferida"
                  : coberturaEmConsulta
                    ? "Conferindo cobertura"
                    : "Cobertura pendente"}
            </span>
          </div>

          {itensSemCobertura > 0 && (
            <div className="wms-sales-create-warning">
              <Icon name="alert" size={13} />
              <span>
                {isFull
                  ? "O Full será criado com reserva parcial e os itens sem cobertura ficarão claros na separação."
                  : "Na baixa direta, o pedido será direcionado para separação em vez de falhar silenciosamente."}
              </span>
            </div>
          )}

          <div className="wms-sales-create-actions">
            <button
              className="wms-btn wms-btn-ghost"
              onClick={() => router.push("/wms/vendas")}
              disabled={enviando}
              type="button"
            >
              Cancelar
            </button>
            <button
              className="wms-btn wms-btn-primary"
              onClick={submit}
              disabled={!valido || enviando || !podeCriar}
              title={!podeCriar ? "Sem permissão para criar venda" : ""}
              type="button"
            >
              {enviando
                ? "Criando…"
                : isFull
                  ? "Criar envio Full"
                  : modo === "separacao"
                    ? "Criar e separar"
                    : "Criar e baixar agora"}
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

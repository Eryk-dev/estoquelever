"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import type { ResultadoVerificacaoDiretaMl } from "@/lib/ml-anuncios-status";
import {
  Icon,
  Kpi,
  PageHeader,
  Pagination,
  fmtDateTime,
  fmtNum,
} from "@/components/wms/ui/wms-ui";

const PAGE_SIZE = 50;
const VERIFY_BATCH_SIZE = 10;

interface EstoqueSemAnuncioRow {
  produto_id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  saldo: number;
  reservado: number;
  disponivel: number;
  situacao: "candidato" | "sem_anuncio_no_snapshot_completo";
  galpoes: Array<{ nome: string; saldo: number }>;
}

interface EstoqueSemAnuncioResponse {
  rows: EstoqueSemAnuncioRow[];
  produtos_com_saldo: number;
  contas_ativas: number;
  contas_indexadas: number;
  anuncios_ativos_indexados: number;
  indice_atualizado_em: string | null;
  indice_completo_disponivel: boolean;
  varredura_completa_em: string | null;
  snapshot_mais_antigo_em: string | null;
  indice_valido_ate: string | null;
  contas_indice: Array<{
    conexao_id: string;
    nickname: string;
    status: string;
    varredura_completa_em: string | null;
    itens_indexados: number | null;
  }>;
  tipo_lista: "candidatos" | "sem_anuncio_no_snapshot_completo";
  ausencia_conclusiva: boolean;
  limitacao_busca_direta: string | null;
  gerado_em: string;
}

type Verificacao =
  | { status: "verificando" }
  | { status: "inconclusivo_busca_direta" }
  | { status: "com_anuncio"; anunciosAtivos: number }
  | { status: "erro"; mensagem: string };

function skuKey(sku: string): string {
  return sku.trim().toLocaleUpperCase();
}

export default function EstoqueSemAnuncioPage() {
  const router = useRouter();
  const { activeGalpaoId, activeGalpaoNome } = useAuth();
  const [busca, setBusca] = useState("");
  const [page, setPage] = useState(1);
  const [verificacoes, setVerificacoes] = useState<
    Record<string, Verificacao>
  >({});
  const [verificandoLote, setVerificandoLote] = useState(false);

  const query = useQuery({
    queryKey: ["wms-estoque-sem-anuncio", activeGalpaoId],
    queryFn: () => {
      const params = new URLSearchParams();
      if (activeGalpaoId) params.set("galpao_id", activeGalpaoId);
      const qs = params.toString();
      return wmsApi<EstoqueSemAnuncioResponse>(
        `/api/wms/estoque/sem-anuncio${qs ? `?${qs}` : ""}`,
      );
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setPage(1);
  }, [busca, activeGalpaoId]);

  useEffect(() => {
    setVerificacoes({});
  }, [activeGalpaoId]);

  const rows = useMemo(() => query.data?.rows ?? [], [query.data?.rows]);
  const rowsEmAberto = useMemo(
    () =>
      rows.filter(
        (row) => verificacoes[skuKey(row.sku)]?.status !== "com_anuncio",
      ),
    [rows, verificacoes],
  );
  const filtradas = useMemo(() => {
    const q = busca.trim().toLocaleLowerCase();
    if (!q) return rowsEmAberto;
    return rowsEmAberto.filter(
      (row) =>
        row.sku.toLocaleLowerCase().includes(q) ||
        row.descricao.toLocaleLowerCase().includes(q),
    );
  }, [busca, rowsEmAberto]);
  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagina = filtradas.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  const inconclusivosBuscaDireta = rows.filter(
    (row) =>
      verificacoes[skuKey(row.sku)]?.status === "inconclusivo_busca_direta",
  ).length;
  const encontradosNaSessao = rows.filter(
    (row) => verificacoes[skuKey(row.sku)]?.status === "com_anuncio",
  ).length;
  const confirmadosSnapshot = rows.filter(
    (row) => row.situacao === "sem_anuncio_no_snapshot_completo",
  ).length;
  const pendentes = rowsEmAberto.filter(
    (row) =>
      row.situacao === "candidato" &&
      !verificacoes[skuKey(row.sku)],
  ).length;
  const comAnuncioConhecido = query.data
    ? query.data.produtos_com_saldo - rows.length + encontradosNaSessao
    : 0;
  const unidades = rowsEmAberto.reduce(
    (total, row) => total + row.saldo,
    0,
  );
  const temCandidatoNaPagina = pagina.some(
    (row) => row.situacao === "candidato",
  );

  async function verificar(
    row: EstoqueSemAnuncioRow,
    avisar = true,
  ): Promise<"com_anuncio" | "inconclusivo_busca_direta" | "erro"> {
    const key = skuKey(row.sku);
    setVerificacoes((atual) => ({
      ...atual,
      [key]: { status: "verificando" },
    }));

    try {
      const resultado = await wmsApi<ResultadoVerificacaoDiretaMl>(
        "/api/wms/estoque/sem-anuncio/verificar",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sku: row.sku }),
        },
      );
      const verificacao: Verificacao =
        resultado.situacao === "inconclusivo_busca_direta"
          ? { status: "inconclusivo_busca_direta" }
          : {
              status: "com_anuncio",
              anunciosAtivos: resultado.anuncios_ativos,
            };
      setVerificacoes((atual) => ({ ...atual, [key]: verificacao }));

      if (avisar) {
        if (resultado.situacao === "inconclusivo_busca_direta") {
          toast.info(
            `${row.sku}: nenhum anúncio ativo foi localizado na busca direta; resultado inconclusivo`,
          );
        } else {
          toast.info(
            `${row.sku}: ${resultado.anuncios_ativos} anúncio(s) ativo(s) encontrado(s)`,
          );
        }
      }
      return resultado.situacao;
    } catch (error) {
      const mensagem =
        error instanceof Error ? error.message : "Falha ao consultar o SKU";
      setVerificacoes((atual) => ({
        ...atual,
        [key]: { status: "erro", mensagem },
      }));
      if (avisar) toast.error(`${row.sku}: ${mensagem}`);
      return "erro";
    }
  }

  async function verificarPagina() {
    const lote = pagina
      .filter((row) => {
        const status = verificacoes[skuKey(row.sku)]?.status;
        return (
          row.situacao === "candidato" &&
          (!status || status === "erro")
        );
      })
      .slice(0, VERIFY_BATCH_SIZE);
    if (lote.length === 0) {
      toast.info("Não há SKUs pendentes nesta página.");
      return;
    }

    setVerificandoLote(true);
    let inconclusivos = 0;
    let comAnuncio = 0;
    let erros = 0;
    try {
      // Duas filas em paralelo limitam a pressão nas quatro contas ML.
      let proximo = 0;
      const worker = async () => {
        while (proximo < lote.length) {
          const row = lote[proximo++];
          const resultado = await verificar(row, false);
          if (resultado === "inconclusivo_busca_direta") inconclusivos++;
          else if (resultado === "com_anuncio") comAnuncio++;
          else erros++;
        }
      };
      await Promise.all([worker(), worker()]);
      toast.info(
        `Verificação concluída: ${inconclusivos} inconclusivo(s) na busca direta, ${comAnuncio} com anúncio${
          erros ? `, ${erros} com erro` : ""
        }.`,
      );
    } finally {
      setVerificandoLote(false);
    }
  }

  const data = query.data;

  return (
    <>
      <PageHeader
        title={
          data?.ausencia_conclusiva
            ? "Estoque sem anúncio no último scan"
            : "Estoque para conferir anúncios"
        }
        subtitle={`Produtos com saldo cruzados com o Mercado Livre${
          activeGalpaoNome ? ` · ${activeGalpaoNome}` : ""
        }`}
        backHref="/wms/estoque"
        backLabel="Voltar ao estoque"
      >
        <button
          type="button"
          className="wms-btn wms-btn-ghost"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          <Icon name="rotate" size={12} />
          {query.isFetching ? "Atualizando…" : "Atualizar lista"}
        </button>
      </PageHeader>

      {query.isLoading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="wms-skel"
              style={{ height: 52, borderRadius: "var(--wms-r-2)" }}
            />
          ))}
        </div>
      )}

      {query.isError && (
        <div className="wms-hint-card wms-hint-danger">
          <Icon name="alert" />
          <span>
            {query.error instanceof Error
              ? query.error.message
              : "Não foi possível montar a lista."}
          </span>
        </div>
      )}

      {data && (
        <>
          <div className="wms-hint-card" style={{ marginBottom: 12 }}>
            <Icon name="alert" />
            <span>
              {data.ausencia_conclusiva ? (
                <>
                  Todas as {data.contas_ativas} conta(s) ativa(s) tiveram uma
                  varredura completa recente, incluindo SKUs dentro de
                  variações. A ausência é confirmada no snapshot concluído em{" "}
                  <strong>
                    {data.varredura_completa_em
                      ? fmtDateTime(data.varredura_completa_em)
                      : "—"}
                  </strong>
                  ; mudanças posteriores entram no próximo scan.
                </>
              ) : (
                <>
                  Esta é uma fila de candidatos, não uma confirmação de
                  ausência. A consulta direta confirma quando encontra anúncio
                  ativo, mas um resultado vazio é inconclusivo.{" "}
                  {data.limitacao_busca_direta} O índice completo está
                  disponível para {data.contas_indexadas} de{" "}
                  {data.contas_ativas} conta(s); a verificação em lote processa
                  no máximo {VERIFY_BATCH_SIZE} SKUs por vez.
                </>
              )}
            </span>
          </div>

          {data.contas_ativas === 0 && (
            <div
              className="wms-hint-card wms-hint-danger"
              style={{ marginBottom: 12 }}
            >
              <Icon name="alert" />
              <span>
                Nenhuma conta Mercado Livre ativa. A lista pode ser consultada,
                mas não é possível verificar os SKUs agora.
              </span>
            </div>
          )}

          <div className="wms-kpis">
            <Kpi
              label={
                data.ausencia_conclusiva
                  ? "Sem anúncio no snapshot"
                  : "A verificar"
              }
              value={fmtNum(
                data.ausencia_conclusiva
                  ? confirmadosSnapshot
                  : Math.max(0, pendentes),
              )}
            />
            <Kpi
              label="Busca direta inconclusiva"
              value={fmtNum(inconclusivosBuscaDireta)}
            />
            <Kpi label="Com anúncio conhecido" value={fmtNum(comAnuncioConhecido)} />
            <Kpi label="Unidades na fila" value={fmtNum(unidades)} />
            <Kpi
              label="Contas ML ativas"
              value={fmtNum(data.contas_ativas)}
              sub={
                data.indice_atualizado_em
                  ? `índice ${fmtDateTime(data.indice_atualizado_em)}`
                  : `lista ${fmtDateTime(data.gerado_em)}`
              }
            />
          </div>

          <div className="wms-toolbar">
            <div className="wms-search-wrap">
              <Icon name="search" size={13} />
              <input
                value={busca}
                onChange={(event) => setBusca(event.target.value)}
                placeholder="Buscar SKU ou descrição…"
              />
              {busca && (
                <button
                  type="button"
                  className="wms-search-clear"
                  onClick={() => setBusca("")}
                  aria-label="Limpar busca"
                >
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              onClick={verificarPagina}
              disabled={
                verificandoLote ||
                data.contas_ativas === 0 ||
                !temCandidatoNaPagina
              }
            >
              {verificandoLote
                ? "Verificando…"
                : `Verificar até ${VERIFY_BATCH_SIZE} desta página`}
            </button>
          </div>

          {pagina.length > 0 ? (
            <>
              <div className="wms-tbl">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 42 }}></th>
                      <th>SKU</th>
                      <th>Descrição</th>
                      <th>Galpões</th>
                      <th className="wms-tar">Físico</th>
                      <th className="wms-tar">Disponível</th>
                      <th>Situação</th>
                      <th style={{ width: 120 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagina.map((row) => {
                      const verificacao = verificacoes[skuKey(row.sku)];
                      return (
                        <tr
                          key={row.produto_id}
                          className="wms-tr-clickable"
                          onClick={() =>
                            router.push(
                              `/wms/estoque?produto=${encodeURIComponent(
                                row.produto_id,
                              )}`,
                            )
                          }
                        >
                          <td>
                            {row.imagem_url && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={row.imagem_url}
                                alt=""
                                className="wms-thumb wms-thumb-sm"
                                loading="lazy"
                              />
                            )}
                          </td>
                          <td className="wms-mono wms-td-strong">{row.sku}</td>
                          <td className="wms-td-desc">{row.descricao}</td>
                          <td>
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 4,
                              }}
                            >
                              {row.galpoes.map((galpao) => (
                                <span
                                  key={galpao.nome}
                                  className="wms-pcard-chip is-galpao"
                                >
                                  {galpao.nome} · {fmtNum(galpao.saldo)}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="wms-tar wms-mono">
                            {fmtNum(row.saldo)}
                          </td>
                          <td className="wms-tar wms-mono wms-td-strong">
                            {fmtNum(row.disponivel)}
                          </td>
                          <td>
                            {!verificacao &&
                              row.situacao ===
                                "sem_anuncio_no_snapshot_completo" && (
                                <span className="wms-badge wms-badge-warn">
                                  Sem anúncio no snapshot
                                </span>
                              )}
                            {!verificacao && row.situacao === "candidato" && (
                              <span className="wms-badge wms-badge-mute">
                                A verificar
                              </span>
                            )}
                            {verificacao?.status === "verificando" && (
                              <span className="wms-badge wms-badge-info">
                                Consultando…
                              </span>
                            )}
                            {verificacao?.status ===
                              "inconclusivo_busca_direta" && (
                              <span className="wms-badge wms-badge-warn">
                                Busca direta inconclusiva
                              </span>
                            )}
                            {verificacao?.status === "erro" && (
                              <span
                                className="wms-badge wms-badge-danger"
                                title={verificacao.mensagem}
                              >
                                Erro na consulta
                              </span>
                            )}
                          </td>
                          <td className="wms-td-actions">
                            <button
                              type="button"
                              className="wms-btn wms-btn-ghost wms-btn-sm"
                              disabled={
                                verificacao?.status === "verificando" ||
                                data.contas_ativas === 0 ||
                                row.situacao ===
                                  "sem_anuncio_no_snapshot_completo"
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void verificar(row);
                              }}
                            >
                              {row.situacao ===
                              "sem_anuncio_no_snapshot_completo"
                                ? "Índice completo"
                                : verificacao?.status ===
                                "inconclusivo_busca_direta" ||
                              verificacao?.status === "erro"
                                ? "Verificar de novo"
                                : "Verificar"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <Pagination
                total={filtradas.length}
                pageSize={PAGE_SIZE}
                page={safePage}
                onPageChange={setPage}
                label="produtos"
              />
            </>
          ) : (
            <div className="wms-empty-block">
              <h3>
                {busca
                  ? "Nenhum produto encontrado"
                  : data.produtos_com_saldo === 0
                    ? "Nenhum produto com saldo"
                    : "Nenhum candidato na fila"}
              </h3>
              <p>
                {busca
                  ? "Tente outro SKU ou descrição."
                  : data.ausencia_conclusiva
                    ? "Todos os produtos com saldo têm anúncio ativo no snapshot completo."
                    : "Todos os candidatos desta sessão tiveram anúncio ativo localizado."}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

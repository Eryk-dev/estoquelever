"use client";

// Componentes visuais de vendas pro WMS unificado.
// D4: operador nunca vê empresa — só galpão.
// D6: sem dropdown de decisão, só label final por galpão.
// D8: pílulas 4 cores reaproveitando tokens (info/warn/danger/mute) sobre `disponível`.
// D12: número headline = saldo FÍSICO; badge ao lado mostra reservado + disponível
//      (disponível = saldo - reservado). Cor da reserva herda o tom da pílula
//      (currentColor) pra contrastar em qualquer fundo, inclusive o vermelho ativo.

const nf = new Intl.NumberFormat("pt-BR");

interface EstoqueGalpao {
  saldo: number;
  reservado: number;
  disponivel: number;
  localizacao?: string;
}

interface EstoquePorGalpaoBarProps {
  /** Mapa galpao_nome -> { saldo, reservado, disponivel, localizacao? } */
  estoques: Record<string, EstoqueGalpao>;
  /** Quantidade pedida do item — usada pra calcular se cada galpão "atende" */
  quantidadePedida: number;
  /** Galpão de origem do pedido — pílula deste ganha destaque (`is-active`) */
  galpaoOrigem?: string | null;
  /** Galpão da decisão final (se já decidido) — sobrescreve galpaoOrigem como destacado */
  galpaoDecisaoFinal?: string | null;
  /** Ordem dos galpões. Default: ordem alfabética dos keys de `estoques`. */
  ordemGalpoes?: string[];
}

interface DecisaoLabelProps {
  /** Decisão final do pedido (troca_equivalente = aguardando aprovação de troca) */
  decisao: "propria" | "transferencia" | "oc" | "troca_equivalente";
  /** Galpão de origem (de onde o pedido entrou) */
  galpaoOrigem: string;
  /** Galpão que vai cumprir (mesmo da origem em "propria", outro em "transferencia") */
  galpaoFulfillment?: string | null;
  /** Mostrar versão compacta (sem texto longo, só ícone+galpão) */
  compact?: boolean;
  /**
   * Variante "plain": sem fundo/borda, apenas ícone + texto colorido.
   * Usar em footers de card e linhas compactas onde a tarja lateral já
   * comunica a decisão e o chip preenchido vira ruído visual.
   */
  plain?: boolean;
  /**
   * Plano 4 — detalhes de swap pra tooltip (debug/transparência).
   * Quando presente, mostra "Vai swappar X unidades com Empresa Y" no title.
   * Operador continua vendo só galpão.
   */
  swapDetalhes?: Array<{
    qty: number;
    empresa_par_nome: string;
    galpao_par_nome: string;
  }>;
}

interface ReservaIndicatorProps {
  reservado: number;
  size?: "sm" | "md";
}

// Regras de tone:
//   mute   → galpão sem dado nenhum (saldo == 0 e disponível == 0)
//   danger → tem saldo mas disponível == 0 (tudo reservado) ou saldo == 0
//   ok     → disponível atende a quantidade pedida
//   warn   → disponível > 0 mas insuficiente pra cobrir o pedido
function calcularTone(
  saldo: number,
  disponivel: number,
  quantidadePedida: number,
): "is-mute" | "is-danger" | "is-ok" | "is-warn" {
  if (saldo === 0 && disponivel === 0) return "is-mute";
  if (disponivel === 0) return "is-danger";
  if (disponivel >= quantidadePedida) return "is-ok";
  return "is-warn";
}

function formatarTitle(saldo: number, reservado: number, disponivel: number): string {
  const base = `Disponível: ${nf.format(disponivel)} · Saldo: ${nf.format(saldo)} · Reservado: ${nf.format(reservado)}`;
  return reservado > 0 ? `${base} (em pedidos abertos)` : base;
}

function EstoquePorGalpaoBar(props: EstoquePorGalpaoBarProps) {
  const {
    estoques,
    quantidadePedida,
    galpaoOrigem,
    galpaoDecisaoFinal,
    ordemGalpoes,
  } = props;

  const keys = Object.keys(estoques);
  if (keys.length === 0) {
    return (
      <div className="wms-stk-pills">
        <span className="wms-stk-pill is-mute">
          <span className="wms-stk-pill-galpao">Sem dado</span>
        </span>
      </div>
    );
  }

  const ordem = ordemGalpoes && ordemGalpoes.length > 0 ? ordemGalpoes : [...keys].sort();

  return (
    <div className="wms-stk-pills">
      {ordem.map((galpao) => {
        const dado = estoques[galpao];
        if (!dado) return null;
        const { saldo, reservado, disponivel } = dado;
        const tone = calcularTone(saldo, disponivel, quantidadePedida);
        // decisão final sempre vence origem como pílula destacada
        const isActive =
          (galpaoDecisaoFinal && galpao === galpaoDecisaoFinal) ||
          (!galpaoDecisaoFinal && galpaoOrigem && galpao === galpaoOrigem);
        const className = ["wms-stk-pill", tone, isActive ? "is-active" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <span
            key={galpao}
            className={className}
            title={formatarTitle(saldo, reservado, disponivel)}
          >
            <span className="wms-stk-pill-galpao">{galpao}</span>
            <span className="wms-stk-pill-qty">{nf.format(saldo)}</span>
            {reservado > 0 ? (
              <span className="wms-stk-pill-reserv">
                <span className="wms-stk-reserv-dot" aria-hidden />
                {nf.format(reservado)} res
                <span className="wms-stk-reserv-divider" aria-hidden>
                  ·
                </span>
                {nf.format(disponivel)} disp
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function DecisaoLabel(props: DecisaoLabelProps) {
  const { decisao, galpaoOrigem, galpaoFulfillment, compact, plain, swapDetalhes } = props;
  const className = [
    "wms-dec-label",
    `is-${decisao}`,
    plain ? "is-plain" : "",
    plain && compact ? "is-compact" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Tooltip de swap (Plano 4) — montado quando há swapDetalhes
  const swapTitle =
    swapDetalhes && swapDetalhes.length > 0
      ? swapDetalhes
          .map(
            (s) =>
              `Vai swappar ${s.qty} unidade${s.qty === 1 ? "" : "s"} com ${s.empresa_par_nome} (espelho em ${s.galpao_par_nome})`,
          )
          .join("\n")
      : undefined;

  if (decisao === "propria") {
    return (
      <span className={className} title={swapTitle}>
        <span className="wms-dec-arrow">↑</span>
        {compact ? galpaoOrigem : `Sai daqui (${galpaoOrigem})`}
        {swapDetalhes && swapDetalhes.length > 0 ? (
          <span className="wms-dec-badge" aria-label="swap">⇄</span>
        ) : null}
      </span>
    );
  }

  if (decisao === "transferencia") {
    // Leitura: "pedido em ORIGEM precisa de FONTE" — origem do pedido aponta
    // pra fonte do estoque. É a perspectiva do operador que recebeu o pedido.
    const fonte = galpaoFulfillment ?? "?";
    return (
      <span className={className} title={swapTitle}>
        {galpaoOrigem} <span className="wms-dec-arrow">→</span> {fonte}
      </span>
    );
  }

  if (decisao === "troca_equivalente") {
    return (
      <span className={className}>
        <span className="wms-dec-arrow">⇄</span>
        {compact ? "Troca" : "Troca de Equivalente"}
      </span>
    );
  }

  // oc — não atrela a galpão (depende de fornecedor)
  return (
    <span className={className}>
      <span className="wms-dec-arrow">↓</span>
      {compact ? "OC" : "Comprar"}
    </span>
  );
}

function ReservaIndicator(props: ReservaIndicatorProps) {
  const { reservado } = props;
  if (reservado === 0) return null;
  return (
    <span
      className="wms-stk-pill is-warn"
      title="Reservado em pedidos pendentes/em separação"
    >
      ⏱ {nf.format(reservado)} reservados
    </span>
  );
}

export { EstoquePorGalpaoBar, DecisaoLabel, ReservaIndicator };
export type { EstoquePorGalpaoBarProps, DecisaoLabelProps, ReservaIndicatorProps };

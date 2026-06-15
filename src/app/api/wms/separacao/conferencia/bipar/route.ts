import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { resolverPedidoPorBarcode, type PedidoConferencia } from "@/lib/wms/conferencia";
import { registrarEvento } from "@/lib/historico-service";
import { dispararCutoverSePronto } from "@/lib/wms/cutover";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/separacao/conferencia/bipar
 *
 * Bip da etiqueta de envio na bancada de embalagem/conferência.
 *
 * Body: { codigo: string, modo: "embalar" | "conferir" }
 *
 * - modo "embalar": registra QUEM embalou fisicamente o pacote
 *   (embalado_real_por/em). NÃO muda status_separacao. Idempotente pro mesmo
 *   usuário; outro usuário recebe aviso "ja_embalado" sem sobrescrever.
 * - modo "conferir": valida embalado → conferido (claim atômico). Bipar a
 *   próxima etiqueta = OK da anterior (zero clique no caminho feliz);
 *   divergência vai pela rota ../divergencia. Auto-conferência permitida
 *   (mesmo usuário pode embalar e conferir — decisão D5 2026-06-11).
 *
 * Resposta 200: { pedido, itens, via, aviso? }
 *   aviso ∈ "ja_embalado" | "ja_conferido"
 * Erros: 404 nao_encontrado · 409 ambiguo · 422 status_invalido
 */

const LOG_SOURCE = "conferencia-bipar";

interface ItemConferencia {
  id: string;
  sku: string | null;
  gtin: string | null;
  descricao: string | null;
  quantidade_pedida: number;
  imagem_url: string | null;
  imagens: string[];
}

export async function POST(request: NextRequest) {
  const auth = await requireWarehouseAccess(request);
  if (!auth.ok) return auth.response;
  const session = auth.user;

  const body = await request.json().catch(() => null);
  const codigo: unknown = body?.codigo;
  const modo: unknown = body?.modo;

  if (typeof codigo !== "string" || !codigo.trim()) {
    return NextResponse.json({ error: "'codigo' é obrigatório" }, { status: 400 });
  }
  if (modo !== "embalar" && modo !== "conferir") {
    return NextResponse.json(
      { error: "'modo' deve ser 'embalar' ou 'conferir'" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    const resolvido = await resolverPedidoPorBarcode(supabase, codigo);
    if (!resolvido.ok) {
      if (resolvido.erro === "ambiguo") {
        return NextResponse.json(
          { error: "ambiguo", mensagem: "Código casa mais de um pedido — bipe outro código da etiqueta (ex: o da DANFE)" },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "nao_encontrado", mensagem: "Nenhum pedido encontrado pra esse código" },
        { status: 404 },
      );
    }

    let pedido = resolvido.pedido;

    // Conferência opera sobre pacote já embalado (checklist concluído).
    if (pedido.status_separacao !== "embalado" && pedido.status_separacao !== "conferido") {
      return NextResponse.json(
        {
          error: "status_invalido",
          status_atual: pedido.status_separacao,
          mensagem: `Pedido #${pedido.numero ?? pedido.id} está em '${pedido.status_separacao}' — ainda não passou pela embalagem`,
        },
        { status: 422 },
      );
    }

    let aviso: "ja_embalado" | "ja_conferido" | null = null;

    if (modo === "embalar") {
      if (pedido.embalado_real_por) {
        // Idempotente pro mesmo usuário; outro usuário não sobrescreve.
        if (pedido.embalado_real_por !== session.id) aviso = "ja_embalado";
      } else {
        const { data: claimed, error: claimErr } = await supabase
          .from("siso_pedidos")
          .update({
            embalado_real_por: session.id,
            embalado_real_em: new Date().toISOString(),
          })
          .eq("id", pedido.id)
          .is("embalado_real_por", null)
          .select("embalado_real_por, embalado_real_em");
        if (claimErr) {
          logger.logError({
            error: claimErr,
            source: LOG_SOURCE,
            message: "Falha ao registrar embalagem física",
            category: "database",
            pedidoId: pedido.id,
          });
          return NextResponse.json({ error: claimErr.message }, { status: 500 });
        }
        if (claimed && claimed.length > 0) {
          pedido = { ...pedido, ...claimed[0] };
          registrarEvento({
            pedidoId: pedido.id,
            evento: "embalagem_fisica_registrada",
            usuarioId: session.id,
            usuarioNome: session.nome,
            detalhes: { via: resolvido.via },
          }).catch(() => {});
        } else {
          // Race: outro bip reivindicou entre o select e o update
          const atual = await refetch(supabase, pedido.id);
          if (atual) pedido = atual;
          if (pedido.embalado_real_por !== session.id) aviso = "ja_embalado";
        }
      }
    } else {
      // modo conferir
      if (pedido.status_separacao === "conferido") {
        aviso = "ja_conferido";
      } else {
        const { data: claimed, error: claimErr } = await supabase
          .from("siso_pedidos")
          .update({
            status_separacao: "conferido",
            conferido_por: session.id,
            conferido_em: new Date().toISOString(),
          })
          .eq("id", pedido.id)
          .eq("status_separacao", "embalado")
          .select("status_separacao, conferido_por, conferido_em");
        if (claimErr) {
          logger.logError({
            error: claimErr,
            source: LOG_SOURCE,
            message: "Falha ao conferir pedido",
            category: "database",
            pedidoId: pedido.id,
          });
          return NextResponse.json({ error: claimErr.message }, { status: 500 });
        }
        if (claimed && claimed.length > 0) {
          pedido = { ...pedido, ...claimed[0] };
          registrarEvento({
            pedidoId: pedido.id,
            evento: "conferencia_ok",
            usuarioId: session.id,
            usuarioNome: session.nome,
            detalhes: { via: resolvido.via, embalado_real_por: pedido.embalado_real_por },
          }).catch(() => {});
          // Coerência com o cutover (no-op se já rodou — embalado já é forward)
          dispararCutoverSePronto(pedido.id).catch(() => {});
        } else {
          // Race: outro conferente bipou primeiro
          const atual = await refetch(supabase, pedido.id);
          if (atual) pedido = atual;
          aviso = "ja_conferido";
        }
      }
    }

    // Itens esperados no pacote (visíveis — exclui indisponível/cancelado)
    const { data: itens } = await supabase
      .from("siso_pedido_itens")
      .select("id, sku, gtin, descricao, quantidade_pedida, imagem_url, compra_status")
      .eq("pedido_id", pedido.id);

    // Galeria completa por SKU (siso_produtos.imagens) — pra navegar todas as
    // fotos no lightbox. O item só carrega a capa (imagem_url).
    const skusConf = Array.from(
      new Set(
        (itens ?? []).map((i) => i.sku).filter((x): x is string => !!x),
      ),
    );
    const imagensPorSku = new Map<string, string[]>();
    if (skusConf.length > 0) {
      const { data: prods } = await supabase
        .from("siso_produtos")
        .select("sku, imagens")
        .in("sku", skusConf);
      for (const p of prods ?? []) {
        imagensPorSku.set(
          p.sku as string,
          (p.imagens as string[] | null) ?? [],
        );
      }
    }

    const itensVisiveis: ItemConferencia[] = (itens ?? [])
      .filter((i) => i.compra_status !== "indisponivel" && i.compra_status !== "cancelado")
      .map((i) => {
        const capa = i.imagem_url ?? null;
        const galeria = imagensPorSku.get(i.sku ?? "") ?? [];
        return {
          id: i.id,
          sku: i.sku,
          gtin: i.gtin,
          descricao: i.descricao,
          quantidade_pedida: i.quantidade_pedida,
          imagem_url: capa,
          imagens: galeria.length > 0 ? galeria : capa ? [capa] : [],
        };
      });

    // Nomes pros badges "embalado por X" / "conferido por Y"
    const usuarioIds = [pedido.embalado_real_por, pedido.conferido_por].filter(
      (id): id is string => !!id,
    );
    const nomes = new Map<string, string>();
    if (usuarioIds.length > 0) {
      const { data: usuarios } = await supabase
        .from("siso_usuarios")
        .select("id, nome")
        .in("id", usuarioIds);
      for (const u of usuarios ?? []) nomes.set(u.id, u.nome);
    }

    return NextResponse.json({
      pedido: {
        id: pedido.id,
        numero: pedido.numero,
        nome_ecommerce: pedido.nome_ecommerce,
        id_pedido_ecommerce: pedido.id_pedido_ecommerce,
        status_separacao: pedido.status_separacao,
        embalado_real_por: pedido.embalado_real_por,
        embalado_real_por_nome: pedido.embalado_real_por
          ? (nomes.get(pedido.embalado_real_por) ?? null)
          : null,
        embalado_real_em: pedido.embalado_real_em,
        conferido_por: pedido.conferido_por,
        conferido_por_nome: pedido.conferido_por
          ? (nomes.get(pedido.conferido_por) ?? null)
          : null,
        conferido_em: pedido.conferido_em,
        divergencia_tipo: pedido.divergencia_tipo,
      },
      itens: itensVisiveis,
      via: resolvido.via,
      aviso,
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "Erro inesperado no bip de conferência",
      category: "unknown",
      requestPath: "/api/wms/separacao/conferencia/bipar",
      requestMethod: "POST",
      metadata: { modo },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

async function refetch(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
): Promise<PedidoConferencia | null> {
  const { data } = await supabase
    .from("siso_pedidos")
    .select(
      "id, numero, nome_ecommerce, id_pedido_ecommerce, status_separacao, embalado_real_por, embalado_real_em, conferido_por, conferido_em, divergencia_tipo, divergencia_obs, empresa_origem_id, separacao_galpao_id, etiqueta_zpl",
    )
    .eq("id", pedidoId)
    .maybeSingle();
  return (data as PedidoConferencia | null) ?? null;
}

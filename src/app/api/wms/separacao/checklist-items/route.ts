import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { locsBloqueadasSet } from "@/lib/wms/loc-locks";
import { escolherLocCobrindo } from "@/lib/separacao/wms-mapping";

/**
 * GET /api/separacao/checklist-items?pedidos=id1,id2,id3
 *
 * Fetch individual items for the given pedido IDs with LIVE localizacao
 * and saldo from siso_estoque (3D), filtered by the separação galpão.
 *
 * Loc exibida = mesma regra do roteamento/aprovar (picking que cobre a qty
 * inteira, senão maior disponível entre as vendáveis), excluindo locs travadas;
 * saldo/disponivel = soma de todas as locs do galpão pra aquele SKU. NÃO usa o
 * snapshot congelado de siso_pedido_item_estoques — estoque inserido após o
 * webhook reflete imediatamente.
 */

/**
 * Escolhe a loc exibida pro item com a regra "picking só se cobre tudo":
 * `cands` já vem ordenado por disponivel desc e sem locs travadas, então o
 * primeiro picking que sozinho cobre a qty é o de maior disponível; senão a
 * de maior disponível (picking ou overstock). Espelha buscarLocComMaiorSaldoNoGalpao.
 */
function escolherLocExibida(
  cands: Array<{ codigo: string | null; tipo: string | null; disponivel: number }>,
  qty: number,
): string | null {
  return escolherLocCobrindo(cands, qty)?.codigo ?? null;
}
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const pedidosParam = searchParams.get("pedidos");

  if (!pedidosParam) {
    return NextResponse.json(
      { error: "'pedidos' query param é obrigatório" },
      { status: 400 },
    );
  }

  const pedido_ids = pedidosParam.split(",").filter(Boolean);
  if (pedido_ids.length === 0) {
    return NextResponse.json(
      { error: "Nenhum pedido_id válido" },
      { status: 400 },
    );
  }

  const modo = searchParams.get("modo");
  const isPickOC = modo === "pick-oc" || modo === "embalagem-oc";

  const supabase = createServiceClient();

  try {
    // 1. Fetch items for the given pedidos.
    // Compra filtering is applied later based on the pedido status.
    const { data: items, error: itemsError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, gtin, descricao, quantidade_pedida, separacao_marcado, separacao_marcado_em, quantidade_bipada, bipado_completo, imagem_url, compra_status, quantidade_pega, separacao_parcial, parcial_motivo, parcial_em, produto_wms_substituto_id, ordem_full",
      )
      .in("pedido_id", pedido_ids);

    if (itemsError) {
      logger.error("checklist-items", "Failed to fetch items", {
        error: itemsError.message,
      });
      return NextResponse.json(
        { error: itemsError.message },
        { status: 500 },
      );
    }

    // 1b. Troca de equivalência: a SEPARAÇÃO mostra a peça FÍSICA (substituto)
    //     como SE FOSSE o item — sku/descrição/gtin/imagem/loc/saldo são do
    //     substituto. O operador só quer pegar a peça certa; o SKU vendido fica
    //     só no produto_id/NF (D3), invisível pro chão.
    const substitutoIds = Array.from(
      new Set(
        (items ?? [])
          .map((i) => i.produto_wms_substituto_id)
          .filter((x): x is string => !!x),
      ),
    );
    const substitutoMap = new Map<
      string,
      {
        sku: string;
        descricao: string | null;
        gtin: string | null;
        imagem_url: string | null;
        imagens: string[];
      }
    >();
    if (substitutoIds.length > 0) {
      const { data: subs } = await supabase
        .from("siso_produtos")
        .select("id, sku, descricao, gtin, imagens")
        .in("id", substitutoIds);
      for (const s of subs ?? []) {
        const imgs = (s.imagens as string[] | null) ?? [];
        substitutoMap.set(s.id as string, {
          sku: s.sku as string,
          descricao: (s.descricao as string | null) ?? null,
          gtin: (s.gtin as string | null) ?? null,
          imagem_url: imgs[0] ?? null,
          imagens: imgs,
        });
      }
    }

    // Galeria completa (todas as fotos) por SKU — siso_produtos.imagens.
    // O item normal só carrega imagem_url (capa); aqui buscamos o array todo
    // pra galeria do lightbox. Substitutos já trazem imagens via substitutoMap.
    const skusGaleria = Array.from(
      new Set(
        (items ?? [])
          .filter((i) => !i.produto_wms_substituto_id)
          .map((i) => i.sku)
          .filter((x): x is string => !!x),
      ),
    );
    const imagensPorSku = new Map<string, string[]>();
    if (skusGaleria.length > 0) {
      const { data: prods } = await supabase
        .from("siso_produtos")
        .select("sku, imagens")
        .in("sku", skusGaleria);
      for (const p of prods ?? []) {
        imagensPorSku.set(
          p.sku as string,
          (p.imagens as string[] | null) ?? [],
        );
      }
    }
    // SKU efetivo = o do substituto (peça física) quando há troca, senão o vendido.
    const skuEfetivo = (item: {
      sku: string | null;
      produto_wms_substituto_id?: string | null;
    }): string | null =>
      item.produto_wms_substituto_id
        ? (substitutoMap.get(item.produto_wms_substituto_id)?.sku ?? item.sku)
        : item.sku;

    // 2. Fetch empresa_origem_id + separacao_galpao_id per pedido
    const { data: pedidos } = await supabase
      .from("siso_pedidos")
      .select(
        "id, empresa_origem_id, separacao_galpao_id, status_separacao, flag_saldo_apareceu, embalagem_operador_id, embalagem_concluida_em, embalado_real_por, embalado_real_em",
      )
      .in("id", pedido_ids);

    const pedidoStatusMap = new Map<string, string | null>();
    for (const pedido of pedidos ?? []) {
      pedidoStatusMap.set(pedido.id, pedido.status_separacao ?? null);
    }

    // Embalagem & etiqueta (painel DETALHES da aba embalados): quem embalou/
    // emitiu a etiqueta + impressora usada. Nomes via siso_usuarios; impressora
    // do último evento etiqueta_impressa (printerNome novo; printerId p/
    // impressões anteriores ao enriquecimento do evento).
    const embaladorIds = Array.from(
      new Set(
        (pedidos ?? []).flatMap((p) =>
          [p.embalagem_operador_id, p.embalado_real_por].filter(
            (v): v is string => !!v,
          ),
        ),
      ),
    );
    const nomesEmbalador = new Map<string, string>();
    if (embaladorIds.length > 0) {
      const { data: us } = await supabase
        .from("siso_usuarios")
        .select("id, nome")
        .in("id", embaladorIds);
      for (const u of (us ?? []) as { id: string; nome: string }[]) {
        nomesEmbalador.set(u.id, u.nome);
      }
    }

    const impressoraPorPedido = new Map<
      string,
      { nome: string | null; id: number | null; em: string }
    >();
    {
      const { data: eventos } = await supabase
        .from("siso_pedido_historico")
        .select("pedido_id, detalhes, criado_em")
        .in("pedido_id", pedido_ids)
        .eq("evento", "etiqueta_impressa")
        .order("criado_em", { ascending: false });
      for (const e of (eventos ?? []) as {
        pedido_id: string;
        detalhes: Record<string, unknown> | null;
        criado_em: string;
      }[]) {
        if (impressoraPorPedido.has(e.pedido_id)) continue; // 1º = mais recente
        const d = e.detalhes ?? {};
        impressoraPorPedido.set(e.pedido_id, {
          nome:
            typeof d.printerNome === "string" && d.printerNome
              ? d.printerNome
              : null,
          id: typeof d.printerId === "number" ? d.printerId : null,
          em: e.criado_em,
        });
      }
    }

    const pedidosResumo = (pedidos ?? []).map((p) => {
      const imp = impressoraPorPedido.get(p.id);
      return {
        id: p.id,
        status_separacao: p.status_separacao ?? null,
        flag_saldo_apareceu: Boolean(p.flag_saldo_apareceu),
        embalado_por_nome: p.embalagem_operador_id
          ? (nomesEmbalador.get(p.embalagem_operador_id) ?? null)
          : null,
        embalado_em: p.embalagem_concluida_em ?? null,
        embalado_real_por_nome: p.embalado_real_por
          ? (nomesEmbalador.get(p.embalado_real_por) ?? null)
          : null,
        embalado_real_em: p.embalado_real_em ?? null,
        impressora_nome: imp?.nome ?? null,
        impressora_id: imp?.id ?? null,
        etiqueta_impressa_em: imp?.em ?? null,
      };
    });

    // 2b. Resolve the "separating empresa" — the empresa in the galpão
    //     that will physically separate/ship the order.
    //     For propria: same galpão as origem. For transferencia: the other galpão.
    const uniqueGalpaoIds = [
      ...new Set(
        (pedidos ?? []).map((p) => p.separacao_galpao_id).filter(Boolean),
      ),
    ];

    // Map galpao_id -> first active empresa_id
    const galpaoToEmpresaMap = new Map<string, string>();
    if (uniqueGalpaoIds.length > 0) {
      const { data: empresasInGalpoes } = await supabase
        .from("siso_empresas")
        .select("id, galpao_id")
        .in("galpao_id", uniqueGalpaoIds)
        .eq("ativo", true);
      for (const emp of empresasInGalpoes ?? []) {
        if (!galpaoToEmpresaMap.has(emp.galpao_id)) {
          galpaoToEmpresaMap.set(emp.galpao_id, emp.id);
        }
      }
    }

    // pedido -> empresa that will separate (used for stock + localizacao)
    const pedidoSepEmpresaMap = new Map<string, string>();
    const pedidoSepGalpaoMap = new Map<string, string>();
    for (const p of pedidos ?? []) {
      if (p.separacao_galpao_id) {
        pedidoSepGalpaoMap.set(p.id, p.separacao_galpao_id);
        const empresaId = galpaoToEmpresaMap.get(p.separacao_galpao_id);
        if (empresaId) {
          pedidoSepEmpresaMap.set(p.id, empresaId);
          continue;
        }
      }
      // Fallback: use empresa_origem if separacao_galpao_id is missing
      if (p.empresa_origem_id) {
        pedidoSepEmpresaMap.set(p.id, p.empresa_origem_id);
      }
    }

    // 3. Loc + saldo LIVE: agregamos siso_estoque (3D) por (sku, galpão de
    //    separação). Não usa snapshot de siso_pedido_item_estoques —
    //    estoque inserido depois do webhook reflete imediatamente.
    //    Loc exibida = a com maior saldo individual no galpão.
    const sepGalpaoIds = Array.from(new Set(pedidoSepGalpaoMap.values()));
    const skus = Array.from(
      new Set(
        (items ?? []).map((i) => skuEfetivo(i)).filter((s): s is string => !!s),
      ),
    );

    // Map agregado: `${galpao_id}:${sku}` -> { saldo, disponivel } (totais do galpão).
    const liveStockMap = new Map<string, { saldo: number; disponivel: number }>();
    // Candidatos de loc por chave, pra escolher a loc exibida com a mesma regra
    // picking-first do roteamento/aprovar. Filtrados de locs travadas e ordenados
    // por disponivel desc (a regra picking-first assume essa ordem).
    const locCandidatesMap = new Map<
      string,
      Array<{ codigo: string | null; tipo: string | null; disponivel: number }>
    >();

    if (sepGalpaoIds.length > 0 && skus.length > 0) {
      const bloqueadas = await locsBloqueadasSet(supabase);
      type EstoqueRow = {
        saldo: number | string | null;
        disponivel: number | string | null;
        galpao_id: string;
        localizacao_id: string;
        siso_produtos: { sku: string } | null;
        siso_localizacoes: { codigo: string; tipo: string } | null;
      };
      const { data: estoqueRows } = await supabase
        .from("siso_estoque")
        .select(
          "saldo, disponivel, galpao_id, localizacao_id, siso_produtos!inner(sku), siso_localizacoes!inner(codigo, tipo)",
        )
        .in("galpao_id", sepGalpaoIds)
        .in("siso_produtos.sku", skus);

      for (const row of (estoqueRows ?? []) as unknown as EstoqueRow[]) {
        const sku = row.siso_produtos?.sku;
        if (!sku) continue;
        const key = `${row.galpao_id}:${sku}`;
        const saldo = Number(row.saldo ?? 0);
        const disponivel = Number(row.disponivel ?? 0);

        const existing = liveStockMap.get(key);
        if (existing) {
          existing.saldo += saldo;
          existing.disponivel += disponivel;
        } else {
          liveStockMap.set(key, { saldo, disponivel });
        }

        // Candidatos só de locs não-travadas, pra a loc exibida bater com o
        // destino real do pick (que também exclui locs em contagem).
        if (!bloqueadas.has(row.localizacao_id)) {
          const cands = locCandidatesMap.get(key) ?? [];
          cands.push({
            codigo: row.siso_localizacoes?.codigo ?? null,
            tipo: row.siso_localizacoes?.tipo ?? null,
            disponivel,
          });
          locCandidatesMap.set(key, cands);
        }
      }

      for (const cands of locCandidatesMap.values()) {
        cands.sort((a, b) => b.disponivel - a.disponivel);
      }
    }

    // 3b. Fetch galpao name for separating empresas (needed for stock adjustment calls)
    const uniqueEmpresaIds = Array.from(new Set(pedidoSepEmpresaMap.values()));
    const galpaoMap = new Map<string, string>();
    if (uniqueEmpresaIds.length > 0) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id, siso_galpoes!siso_empresas_galpao_id_fkey(nome)")
        .in("id", uniqueEmpresaIds);
      for (const emp of empresas ?? []) {
        const g = emp.siso_galpoes as unknown as { nome: string } | null;
        if (g?.nome) galpaoMap.set(emp.id, g.nome);
      }
    }

    // 3c. Fetch realocacoes (todos os status) para todos os itens.
    // 3D: pool fungível por (produto, galpao) — não expomos empresa_dona/devedora/is_emprestimo.
    const itemIds = (items ?? []).map((i) => i.id);
    let realocacoes: Array<{
      id: string;
      pedido_item_id: number;
      parent_realocacao_id: string | null;
      galpao_id: string | null;
      localizacao_id: string | null;
      quantidade: number;
      quantidade_pega: number | null;
      parcial: boolean;
      parcial_motivo: string | null;
      status: string;
      criado_em: string;
    }> = [];

    if (itemIds.length > 0) {
      const { data: realocacoesRaw } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select(
          "id, pedido_item_id, parent_realocacao_id, galpao_id, localizacao_id, quantidade, quantidade_pega, parcial, parcial_motivo, status, criado_em",
        )
        .in("pedido_item_id", itemIds);
      realocacoes = realocacoesRaw ?? [];
    }

    // Fetch localizacao codes for realocacoes
    const localizacaoIds = [
      ...new Set(realocacoes.map((r) => r.localizacao_id).filter(Boolean) as string[]),
    ];
    const localizacaoCodigoMap = new Map<string, string>();
    if (localizacaoIds.length > 0) {
      const { data: locs } = await supabase
        .from("siso_localizacoes")
        .select("id, codigo")
        .in("id", localizacaoIds);
      for (const loc of locs ?? []) {
        localizacaoCodigoMap.set(loc.id, loc.codigo);
      }
    }

    // Build map pedido_item_id -> realocacoes[]
    const realocacoesPorItem = new Map<string, typeof realocacoes>();
    for (const r of realocacoes) {
      const arr = realocacoesPorItem.get(String(r.pedido_item_id)) ?? [];
      arr.push(r);
      realocacoesPorItem.set(String(r.pedido_item_id), arr);
    }

    // 3d. Loc da RESERVA viva por item — fonte de verdade de ONDE o pick sai.
    //     marcar-item/parcial baixam da loc da R (origem_tipo='reserva_pedido'),
    //     não da heurística de maior-saldo. Sem espelhar isso aqui, a "Troca de
    //     localização" (move a R pra outra loc) não refletia no endereço exibido
    //     — a heurística recomputava e ignorava a R (pior: mover a R baixa o
    //     disponível do destino, então a heurística mostrava o destino MENOS).
    //     Chave `${pedido}:${sku}` (a R guarda o produto WMS; casamos por SKU,
    //     igual ao mapa de saldo). Cascade pode deixar +1 R viva → fica a de
    //     maior quantidade (espelha buscarReservaPendentePorProduto).
    const reservaLocPorPedidoSku = new Map<string, string>();
    {
      const { data: reservasR } = await supabase
        .from("siso_movimentacoes")
        .select("id, origem_id, produto_id, localizacao_id, quantidade")
        .in("origem_id", pedido_ids)
        .eq("origem_tipo", "reserva_pedido")
        .eq("tipo", "R");
      const rIds = (reservasR ?? []).map((r) => r.id as string);
      const liberadasSet = new Set<string>();
      if (rIds.length > 0) {
        const { data: libs } = await supabase
          .from("siso_movimentacoes")
          .select("estorno_de")
          .in("estorno_de", rIds)
          .eq("tipo", "L");
        for (const l of libs ?? []) {
          if (l.estorno_de) liberadasSet.add(l.estorno_de as string);
        }
      }
      const pendentesR = (reservasR ?? []).filter(
        (r) => !liberadasSet.has(r.id as string),
      );
      const prodIdsR = Array.from(
        new Set(pendentesR.map((r) => r.produto_id as string)),
      );
      const skuPorProdutoR = new Map<string, string>();
      if (prodIdsR.length > 0) {
        const { data: prodsR } = await supabase
          .from("siso_produtos")
          .select("id, sku")
          .in("id", prodIdsR);
        for (const p of prodsR ?? []) {
          skuPorProdutoR.set(p.id as string, p.sku as string);
        }
      }
      const melhorQtyR = new Map<string, number>();
      for (const r of pendentesR) {
        const skuR = skuPorProdutoR.get(r.produto_id as string);
        if (!skuR) continue;
        const key = `${r.origem_id}:${skuR}`;
        const qty = Number(r.quantidade ?? 0);
        if (qty >= (melhorQtyR.get(key) ?? -1)) {
          melhorQtyR.set(key, qty);
          reservaLocPorPedidoSku.set(key, r.localizacao_id as string);
        }
      }
      // Resolve códigos das locs de reserva (reusa o mapa das realocações).
      const locIdsReserva = Array.from(
        new Set(reservaLocPorPedidoSku.values()),
      ).filter((id) => !localizacaoCodigoMap.has(id));
      if (locIdsReserva.length > 0) {
        const { data: locsR } = await supabase
          .from("siso_localizacoes")
          .select("id, codigo")
          .in("id", locIdsReserva);
        for (const loc of locsR ?? []) {
          localizacaoCodigoMap.set(loc.id, loc.codigo);
        }
      }
    }

    // 4. Shape response (empresa_origem_id = separating empresa for location updates)
    // In pick-oc mode, show ALL items (including OC items) so the operator can pick them.
    // In normal mode, hide OC items for aguardando_compra pedidos.
    const visibleItems = (items ?? []).filter((item) => {
      if (item.compra_status === "indisponivel" || item.compra_status === "cancelado") {
        return false;
      }

      if (!isPickOC) {
        const pedidoStatus = pedidoStatusMap.get(item.pedido_id);
        if (pedidoStatus === "aguardando_compra") {
          return item.compra_status == null;
        }
      }

      return true;
    });

    const result = visibleItems.map((item) => {
      const sepEmpresaId = pedidoSepEmpresaMap.get(item.pedido_id) ?? null;
      const sepGalpaoId = pedidoSepGalpaoMap.get(item.pedido_id) ?? null;
      const efetivo = skuEfetivo(item);
      const liveKey = sepGalpaoId && efetivo ? `${sepGalpaoId}:${efetivo}` : null;
      const live = liveKey ? liveStockMap.get(liveKey) : undefined;
      const sub = item.produto_wms_substituto_id
        ? (substitutoMap.get(item.produto_wms_substituto_id) ?? null)
        : null;

      const itemRealocacoes = (realocacoesPorItem.get(String(item.id)) ?? []).map((r) => ({
        id: r.id,
        parent_realocacao_id: r.parent_realocacao_id,
        localizacao_id: r.localizacao_id,
        localizacao_codigo: r.localizacao_id
          ? (localizacaoCodigoMap.get(r.localizacao_id) ?? null)
          : null,
        quantidade: r.quantidade,
        quantidade_pega: r.quantidade_pega,
        parcial: r.parcial,
        parcial_motivo: r.parcial_motivo,
        status: r.status,
        criado_em: r.criado_em,
      }));
      const capaImagem = sub?.imagem_url ?? item.imagem_url ?? null;
      const galeriaImagens = item.produto_wms_substituto_id
        ? (sub?.imagens ?? [])
        : (imagensPorSku.get(item.sku ?? "") ?? []);
      // Loc exibida: prefere a loc da R viva (onde o pick vai realmente sair),
      // caindo na heurística de saldo só quando não há reserva (OC, já picado).
      const locHeuristica = liveKey
        ? escolherLocExibida(
            locCandidatesMap.get(liveKey) ?? [],
            Number(item.quantidade_pedida ?? 0),
          )
        : null;
      const reservaLocId = efetivo
        ? reservaLocPorPedidoSku.get(`${item.pedido_id}:${efetivo}`)
        : undefined;
      const locReserva = reservaLocId
        ? (localizacaoCodigoMap.get(reservaLocId) ?? null)
        : null;
      return {
        id: item.id,
        pedido_id: item.pedido_id,
        produto_id: item.produto_id,
        // Troca de equivalência: exibe a peça física (substituto) como item.
        sku: sub?.sku ?? item.sku,
        gtin: sub?.gtin ?? item.gtin,
        descricao: sub?.descricao ?? item.descricao,
        quantidade: item.quantidade_pedida,
        separacao_marcado: item.separacao_marcado ?? false,
        separacao_marcado_em: item.separacao_marcado_em,
        quantidade_bipada: item.quantidade_bipada ?? 0,
        bipado_completo: item.bipado_completo ?? false,
        imagem_url: capaImagem,
        imagens:
          galeriaImagens.length > 0
            ? galeriaImagens
            : capaImagem
              ? [capaImagem]
              : [],
        compra_status: item.compra_status ?? null,
        localizacao: locReserva ?? locHeuristica,
        saldo: live?.saldo ?? 0,
        disponivel: live?.disponivel ?? 0,
        // Nº de locs pegáveis (disponivel>0, não-travadas) no galpão. Gate da
        // flechinha "outras localizações": só faz sentido quando há mais de uma.
        locs_disponiveis: liveKey
          ? (locCandidatesMap.get(liveKey) ?? []).filter((c) => c.disponivel > 0)
              .length
          : 0,
        empresa_origem_id: sepEmpresaId,
        separacao_galpao_id: sepGalpaoId,
        galpao_nome: galpaoMap.get(sepEmpresaId ?? "") ?? null,
        quantidade_pega: item.quantidade_pega ?? null,
        separacao_parcial: item.separacao_parcial ?? false,
        parcial_motivo: item.parcial_motivo ?? null,
        parcial_em: item.parcial_em ?? null,
        realocacoes: itemRealocacoes,
        ordem_full: item.ordem_full ?? null,
      };
    });

    return NextResponse.json({ items: result, pedidos: pedidosResumo });
  } catch (err) {
    logger.error("checklist-items", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

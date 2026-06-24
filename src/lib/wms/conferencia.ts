/**
 * Conferência de embalagem — resolução do bip da etiqueta de envio.
 *
 * O operador bipa o barcode da etiqueta (ML: shipment/QR do ZPL; Shopee:
 * codigoRastreio; DANFE: chave NF 44 dígitos) e precisamos achar o pedido.
 *
 * O valor cru do leitor vira uma lista de CANDIDATOS (`derivarCandidatos`): o
 * próprio valor, sem prefixo AIM (`]Q1…`) e o `id` do JSON do QR (ancorado no
 * campo `id`; runs de dígitos só quando NÃO é QR ML). Isso é o que faz o QR do
 * ML casar: o payload é `{"id":"47362139627","t":"lm"}` (Flex traz mais campos:
 * `sender_id`/`hash_code`/`security_digit`), mas o shipment id também fica
 * guardado standalone — então casamos por ele quando o JSON vem garbleado pelo
 * teclado ABNT2 ou o PostgREST não encoda o elemento com `{`/`,`/`"`. NÃO
 * emitimos `sender_id` como candidato: é o id da conta do vendedor (constante
 * entre pedidos do mesmo vendedor) e casaria o pedido errado.
 *
 * Cadeia de matching (mais forte → mais fraco):
 *   1. etiqueta_barcodes && {candidatos}  (overlap; + match exato do cru)
 *   2. chave_acesso_nf = candidato 44-díg  (DANFE)
 *   3. id_pedido_ecommerce ∈ {candidatos}  (nº do pedido impresso na etiqueta)
 *   4. etiqueta_zpl ILIKE %run-dígitos%    (etiquetas antigas sem barcodes; self-heal)
 */

import type { createServiceClient } from "@/lib/supabase-server";
import { montarBarcodesEtiqueta } from "@/lib/etiqueta-barcode";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "conferencia";

type SupabaseClient = ReturnType<typeof createServiceClient>;

export const PEDIDO_CONFERENCIA_SELECT =
  "id, numero, nome_ecommerce, id_pedido_ecommerce, status_separacao, " +
  "embalado_real_por, embalado_real_em, conferido_por, conferido_em, " +
  "divergencia_tipo, divergencia_obs, empresa_origem_id, separacao_galpao_id, etiqueta_zpl";

export interface PedidoConferencia {
  id: string;
  numero: string | null;
  nome_ecommerce: string | null;
  id_pedido_ecommerce: string | null;
  status_separacao: string | null;
  embalado_real_por: string | null;
  embalado_real_em: string | null;
  conferido_por: string | null;
  conferido_em: string | null;
  divergencia_tipo: string | null;
  divergencia_obs: string | null;
  empresa_origem_id: string | null;
  separacao_galpao_id: string | null;
  etiqueta_zpl: string | null;
}

export type ViaResolucao = "barcode" | "chave_nf" | "pedido_ecommerce" | "zpl_self_heal";

export type ResolverResultado =
  | { ok: true; pedido: PedidoConferencia; via: ViaResolucao }
  | { ok: false; erro: "codigo_vazio" | "nao_encontrado" | "ambiguo" };

/** Chave de acesso de NF-e: exatamente 44 dígitos. */
export function ehChaveNf(codigo: string): boolean {
  return /^\d{44}$/.test(codigo);
}

/** Escapa curingas de LIKE/ILIKE (% _ \) pro fallback no ZPL bruto. */
export function escaparLike(codigo: string): string {
  return codigo.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Tira o identificador de simbologia AIM que alguns leitores prefixam ao valor
 * lido (`]Q1` = QR, `]C0` = Code128, `]d2` = DataMatrix…). São 3 chars: `]` +
 * letra da simbologia + dígito modificador.
 */
export function tirarPrefixoAim(codigo: string): string {
  return codigo.replace(/^\][A-Za-z][0-9]/, "");
}

/**
 * Runs contíguos de 8+ dígitos (shipment id ML = 11, nº pedido = 16, chave NF =
 * 44). Sobrevivem ao garble de layout de teclado: quando o leitor bipa o QR do
 * ML (`{"id":"47362139627","t":"lm"}`) num teclado ABNT2, as chaves/aspas/`:`
 * trocam de tecla, mas os dígitos saem iguais.
 */
export function extrairRunsDigitos(codigo: string): string[] {
  return codigo.match(/\d{8,}/g) ?? [];
}

/**
 * Deriva candidatos de match a partir do valor cru do leitor. Cobre:
 * - valor limpo (QR JSON, Code128, chave NF) — fica em 1º
 * - prefixo AIM removido (`]Q1…`)
 * - `id` de dentro do JSON do QR ML
 * - shipment id como run de dígitos — casa o Code128 já guardado mesmo quando o
 *   JSON do QR vem garbleado pelo teclado OU o PostgREST não consegue encodar o
 *   elemento com `{` `,` `"` num literal de array.
 * Dedup.
 */
export function derivarCandidatos(codigoRaw: string): string[] {
  const codigo = (codigoRaw ?? "").trim();
  const out = new Set<string>();
  if (codigo) out.add(codigo);
  const semAim = tirarPrefixoAim(codigo);
  if (semAim) out.add(semAim);
  // O shipment id é o campo `id` do QR (1º campo). Ancorar NELE:
  // - idLimpo: JSON íntegro (cobre id alfanumérico, ex. `"id":"AB12CD34"`).
  // - idGarble: teclado ABNT2 garbleia `"id":` → `^id^Ç^`, mas os dígitos
  //   sobrevivem. `.exec` (não-global) pega a 1ª ocorrência = o id real, nunca
  //   o `id` de `sender_id` que vem depois.
  const idLimpo = /"id"\s*:\s*"?([\w-]{6,})"?/.exec(codigo);
  const idGarble = /(?:^|[^0-9a-z])id[^0-9]{0,6}(\d{8,})/i.exec(codigo);
  if (idLimpo) out.add(idLimpo[1]);
  if (idGarble) out.add(idGarble[1]);
  // Runs cegos SÓ quando não é QR ML (Code128 cru, chave NF). No QR Flex os
  // campos extras (`sender_id` constante por vendedor, `security_digit`)
  // colidiriam entre pedidos — por isso não os emitimos como candidatos.
  if (!idLimpo && !idGarble) {
    for (const run of extrairRunsDigitos(semAim)) out.add(run);
  }
  return Array.from(out);
}

export async function resolverPedidoPorBarcode(
  supabase: SupabaseClient,
  codigoRaw: string,
): Promise<ResolverResultado> {
  const codigo = (codigoRaw ?? "").trim();
  if (codigo.length < 4) return { ok: false, erro: "codigo_vazio" };

  const candidatos = derivarCandidatos(codigo);
  // Candidatos "seguros" pra casar em array/igualdade: alfanuméricos, sem
  // vírgula/chave/aspas que quebrariam o literal de array do PostgREST.
  const seguros = candidatos.filter((c) => /^[A-Za-z0-9._-]{4,}$/.test(c));

  // 1. Match no array de barcodes. `overlaps` casa quando QUALQUER candidato
  //    seguro == QUALQUER barcode guardado — pega o shipment id do QR ML, que
  //    fica guardado como Code128 (`47362139627`), mesmo com o JSON garbleado.
  let porBarcode: PedidoConferencia[] | null = null;
  if (seguros.length > 0) {
    const { data } = await supabase
      .from("siso_pedidos")
      .select(PEDIDO_CONFERENCIA_SELECT)
      .overlaps("etiqueta_barcodes", seguros)
      .limit(2)
      .returns<PedidoConferencia[]>();
    porBarcode = data;
  }
  // QR JSON limpo (chars especiais): tenta o match exato do valor cru.
  if ((!porBarcode || porBarcode.length === 0) && !seguros.includes(codigo)) {
    const { data } = await supabase
      .from("siso_pedidos")
      .select(PEDIDO_CONFERENCIA_SELECT)
      .contains("etiqueta_barcodes", [codigo])
      .limit(2)
      .returns<PedidoConferencia[]>();
    porBarcode = data;
  }
  if (porBarcode && porBarcode.length === 1) {
    return { ok: true, pedido: porBarcode[0], via: "barcode" };
  }
  if (porBarcode && porBarcode.length > 1) return { ok: false, erro: "ambiguo" };

  // 2. Chave NF (DANFE) — qualquer candidato de 44 dígitos.
  const chave = candidatos.find((c) => ehChaveNf(c));
  if (chave) {
    const { data: porChave } = await supabase
      .from("siso_pedidos")
      .select(PEDIDO_CONFERENCIA_SELECT)
      .eq("chave_acesso_nf", chave)
      .limit(2)
      .returns<PedidoConferencia[]>();
    if (porChave && porChave.length === 1) {
      return { ok: true, pedido: porChave[0], via: "chave_nf" };
    }
    if (porChave && porChave.length > 1) return { ok: false, erro: "ambiguo" };
  }

  // 3. Nº do pedido no marketplace (escopo: pedidos na bancada, evita casar
  //    pedido antigo do mesmo comprador)
  const { data: porEcommerce } = await supabase
    .from("siso_pedidos")
    .select(PEDIDO_CONFERENCIA_SELECT)
    .in("id_pedido_ecommerce", seguros.length > 0 ? seguros : [codigo])
    .in("status_separacao", ["separado", "embalado", "conferido"])
    .limit(2)
    .returns<PedidoConferencia[]>();
  if (porEcommerce && porEcommerce.length === 1) {
    return { ok: true, pedido: porEcommerce[0], via: "pedido_ecommerce" };
  }
  if (porEcommerce && porEcommerce.length > 1) return { ok: false, erro: "ambiguo" };

  // 4. Fallback: etiqueta antiga sem etiqueta_barcodes — procura no ZPL bruto
  //    (janela 30d). Usa os candidatos seguros (shipment id, sobrevive ao garble)
  //    e o cru; achando, self-heal: persiste os barcodes (incl. o shipment id).
  //    NÃO usa runs cegos: o `sender_id` do QR Flex aparece no ZPL de TODO pedido
  //    do mesmo vendedor → daria falso "ambíguo".
  const corte = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const alvosZpl = Array.from(new Set([...seguros, codigo]));
  for (const alvo of alvosZpl) {
    if (alvo.length < 4) continue;
    const { data: porZpl } = await supabase
      .from("siso_pedidos")
      .select(PEDIDO_CONFERENCIA_SELECT)
      .ilike("etiqueta_zpl", `%${escaparLike(alvo)}%`)
      .in("status_separacao", ["separado", "embalado", "conferido"])
      .gte("criado_em", corte)
      .limit(2)
      .returns<PedidoConferencia[]>();
    if (porZpl && porZpl.length > 1) return { ok: false, erro: "ambiguo" };
    if (porZpl && porZpl.length === 1) {
      const pedido = porZpl[0];
      // Candidatos derivados (cru + shipment id), NÃO runs cegos — senão o
      // sender_id do QR Flex voltaria a ser guardado standalone e re-colidiria.
      const barcodes = montarBarcodesEtiqueta(
        pedido.etiqueta_zpl,
        derivarCandidatos(codigo),
      );
      supabase
        .from("siso_pedidos")
        .update({ etiqueta_barcodes: barcodes })
        .eq("id", pedido.id)
        .then(({ error }) => {
          if (error) {
            logger.warn(LOG_SOURCE, "Self-heal de etiqueta_barcodes falhou", {
              pedidoId: pedido.id,
              error: error.message,
            });
          }
        });
      return { ok: true, pedido, via: "zpl_self_heal" };
    }
  }

  return { ok: false, erro: "nao_encontrado" };
}

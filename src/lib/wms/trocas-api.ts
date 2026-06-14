import { NextResponse } from "next/server";
import type { TrocaError } from "./trocas-equivalencia";

/** Mapeia TrocaError.code → HTTP status (compartilhado pelas rotas /trocas). */
const HTTP_POR_CODE: Record<TrocaError["code"], number> = {
  ITEM_NAO_ENCONTRADO: 404,
  PEDIDO_NAO_ENCONTRADO: 404,
  SUBSTITUTO_NAO_ENCONTRADO: 404,
  TROCA_NAO_ENCONTRADA: 404,
  PEDIDO_ESTADO_INVALIDO: 409,
  ITEM_JA_SEPARADO: 409,
  TROCA_JA_APLICADA: 409,
  TROCA_PENDENTE_EXISTE: 409,
  TROCA_NAO_PENDENTE: 409,
  PAR_BLOQUEADO: 409,
  SEM_SALDO_SUBSTITUTO: 422,
  SUBSTITUTO_IGUAL_VENDIDO: 400,
  SUBSTITUTO_IGUAL_ATUAL: 400,
  PRODUTO_VENDIDO_NAO_MAPEADO: 422,
  GALPAO_INDETERMINADO: 422,
};

export function trocaErrorResponse(err: TrocaError) {
  return NextResponse.json(
    { error: err.message, code: err.code },
    { status: HTTP_POR_CODE[err.code] ?? 400 },
  );
}

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * POST /api/wms/encaixotamento/bipar
 *
 * Encaixotamento por dia — etapa pós-separação na pista FUTURA. O operador bipa
 * SKU/EAN + qty e o sistema deposita a qty nas caixas (DIA de despacho dos
 * pedidos futura já separados), FIFO por prazo_envio (caixa mais urgente
 * primeiro). Atômico via RPC (lock por item serializa multi-operador).
 *
 * Body: { codigo: string, qty: number }
 * Resposta 200: { ok, codigo, sku, descricao, imagem_url, qty_pedida,
 *                 qty_alocada, sobra, alocacoes: [{ pedido_id, pedido_item_id,
 *                 numero, prazo_envio, dia, qty }] }
 * Erros: 400 validação · 404 sem_caixa (nada futura/separado precisa do código)
 */

interface Alocacao {
  pedido_id: string;
  pedido_item_id: string;
  numero: string | null;
  prazo_envio: string | null;
  dia: string | null;
  qty: number;
}
interface EncaixotarResposta {
  codigo: string;
  sku: string | null;
  descricao: string | null;
  imagem_url: string | null;
  qty_pedida: number;
  qty_alocada: number;
  sobra: number;
  alocacoes: Alocacao[];
}

export async function POST(request: NextRequest) {
  const auth = await requireWarehouseAccess(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const codigo: unknown = body?.codigo;
  const qtyRaw: unknown = body?.qty;

  if (typeof codigo !== "string" || !codigo.trim()) {
    return NextResponse.json({ error: "'codigo' é obrigatório" }, { status: 400 });
  }
  const qty = typeof qtyRaw === "number" ? qtyRaw : Number(qtyRaw);
  if (!Number.isInteger(qty) || qty <= 0) {
    return NextResponse.json({ error: "'qty' deve ser um inteiro > 0" }, { status: 400 });
  }

  const supabase = createServiceClient();

  try {
    const { data, error } = await supabase.rpc("wms_encaixotar_atomico", {
      p_codigo: codigo.trim(),
      p_qty: qty,
    });
    if (error) {
      return wmsErrorResponse({
        source: "wms.encaixotamento.bipar",
        error,
        message: "Falha ao encaixotar",
        requestPath: "/api/wms/encaixotamento/bipar",
        requestMethod: "POST",
        metadata: { codigo, qty },
      });
    }

    const res = data as EncaixotarResposta;
    if (!res?.alocacoes || res.alocacoes.length === 0) {
      return NextResponse.json(
        {
          error: "sem_caixa",
          mensagem: `Nenhum pedido futura separado precisa de "${codigo.trim()}" agora`,
          ...res,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.encaixotamento.bipar",
      error: e,
      requestPath: "/api/wms/encaixotamento/bipar",
      requestMethod: "POST",
    });
  }
}

/**
 * Vincula cada conexão ML à sua empresa (siso_ml_connections.empresa_id),
 * casando por ml_user_id (estável). Necessário pro enrich de prazo_envio
 * (SLA do ML) achar a conexão certa por empresa_origem_id do pedido.
 *
 * Idempotente. Roda: npx tsx scripts/wms/vincular-ml-empresas.ts
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";

// ml_user_id → empresa_id (validado contra ownership real do ML em 2026-06-15
// via /orders/search + /users/me). EASY UTILIDADES é a conta da EasyPeasy
// (CWB); EasyPeasy SP ainda NÃO tem conta ML conectada.
const MAP: Record<string, { empresaId: string; nota: string }> = {
  "1963376627": { empresaId: "64c46454-b9e6-422e-aeca-4f7c18e1cdf9", nota: "141AIR" },
  "421259712": { empresaId: "4473ca97-67e7-44e5-a192-ec756146b691", nota: "NetAir" },
  "1092904133": { empresaId: "c27d85ce-e469-42dc-ae0f-10b722fa5b37", nota: "NetParts" },
  "735198837": { empresaId: "818f5445-6704-4045-9179-068ba507d480", nota: "EasyPeasy (CWB) = EASY UTILIDADES" },
};

async function main() {
  const sb = createServiceClient();
  for (const [mlUserId, { empresaId, nota }] of Object.entries(MAP)) {
    const { data, error } = await sb
      .from("siso_ml_connections")
      .update({ empresa_id: empresaId })
      .eq("ml_user_id", mlUserId)
      .select("nickname, empresa_id");
    if (error) {
      console.error(`✗ ${nota} (ml_user=${mlUserId}): ${error.message}`);
      continue;
    }
    if (!data || data.length === 0) {
      console.log(`– ${nota} (ml_user=${mlUserId}): nenhuma conexão (skip)`);
      continue;
    }
    console.log(`✓ ${data[0].nickname} → ${nota} (${empresaId})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

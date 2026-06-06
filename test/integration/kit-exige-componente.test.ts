import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

let kitId: string;
let compId: string;
const SKU = `TEST-KIT-INV-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const { data: k } = await sb
    .from("siso_produtos").insert({ sku: `${SKU}-K`, descricao: "Kit inv test", ativo: true })
    .select("id").single();
  kitId = k!.id;
  const { data: c } = await sb
    .from("siso_produtos").insert({ sku: `${SKU}-C`, descricao: "Componente test", ativo: true })
    .select("id").single();
  compId = c!.id;
});

describe("trigger wms_kit_exige_componente", () => {
  it("rejeita eh_kit=true sem nenhuma linha em siso_produto_kits", async () => {
    const { error } = await sb.from("siso_produtos").update({ eh_kit: true }).eq("id", kitId);
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/kit.*componente/i);
  });

  it("aceita eh_kit=true depois de cadastrar ≥1 componente", async () => {
    const { error: ec } = await sb.from("siso_produto_kits").insert({
      kit_produto_id: kitId, componente_produto_id: compId, quantidade: 2,
    });
    expect(ec).toBeNull();
    const { error: ek } = await sb.from("siso_produtos").update({ eh_kit: true }).eq("id", kitId);
    expect(ek).toBeNull();
  });
});

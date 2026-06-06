import { describe, it, expect } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";

const sb = createServiceClient();

describe("siso_cobertura_estoque — shape 3D", () => {
  it("wms_refresh_cobertura() roda sem erro", async () => {
    const { error } = await sb.rpc("wms_refresh_cobertura");
    expect(error).toBeNull();
  });

  it("a MV tem (produto_id, galpao_id, status_cobertura) e NÃO tem empresa_dona_id", async () => {
    // SELECT explícito das colunas 3D — falha se empresa_dona_id ainda fizer parte do shape
    const { error: e3d } = await sb
      .from("siso_cobertura_estoque")
      .select("produto_id, galpao_id, status_cobertura, dias_cobertura")
      .limit(1);
    expect(e3d).toBeNull();

    // Selecionar empresa_dona_id deve FALHAR (coluna não existe no shape 3D)
    const { error: eEmpresa } = await sb
      .from("siso_cobertura_estoque")
      .select("empresa_dona_id")
      .limit(1);
    expect(eEmpresa).not.toBeNull();
  });
});

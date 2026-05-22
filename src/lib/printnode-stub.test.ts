import { describe, it, expect, beforeEach } from "vitest";
import {
  __getPrintJobs,
  __resetPrintJobs,
  enviarImpressaoStub,
  enviarImpressaoZplStub,
  isPrintNodeDisabled,
  listarImpressorasStub,
  testarConexaoStub,
} from "./printnode-stub";

describe("printnode-stub", () => {
  beforeEach(() => __resetPrintJobs());

  it("isPrintNodeDisabled lê env", () => {
    const old = process.env.PRINTNODE_DISABLED;
    process.env.PRINTNODE_DISABLED = "true";
    expect(isPrintNodeDisabled()).toBe(true);
    process.env.PRINTNODE_DISABLED = "false";
    expect(isPrintNodeDisabled()).toBe(false);
    process.env.PRINTNODE_DISABLED = old;
  });

  it("testarConexao sempre retorna ok", async () => {
    const r = await testarConexaoStub();
    expect(r.ok).toBe(true);
    expect(r.email).toBe("stub@local");
  });

  it("listarImpressoras retorna 2 fake estáveis", async () => {
    const r = await listarImpressorasStub();
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe(9001);
    expect(r[1].id).toBe(9002);
  });

  it("enviarImpressao acumula no buffer com IDs incrementais", async () => {
    const a = await enviarImpressaoStub({ printerId: 9001, titulo: "etq-1", contentBase64: "QQ==" });
    const b = await enviarImpressaoStub({ printerId: 9001, titulo: "etq-2", contentBase64: "QkI=" });
    expect(a.id).toBe("printjob-0001");
    expect(b.id).toBe("printjob-0002");
    const jobs = __getPrintJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].tipo).toBe("pdf");
  });

  it("enviarImpressaoZpl registra tipo zpl + tamanho UTF-8", async () => {
    await enviarImpressaoZplStub({ printerId: 9002, titulo: "prod-etq", zpl: "^XA^FO50,50^FDhi^FS^XZ" });
    const jobs = __getPrintJobs();
    expect(jobs[0].tipo).toBe("zpl");
    expect(jobs[0].tamanhoBytes).toBeGreaterThan(0);
  });
});

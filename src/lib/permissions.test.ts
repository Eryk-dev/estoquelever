import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  PERMISSAO_CODIGOS,
  userCan,
  userCanAny,
} from "./permissions";

describe("PERMISSIONS registry", () => {
  it("tem exatamente 38 permissões em 8 módulos", () => {
    expect(PERMISSAO_CODIGOS).toHaveLength(38);
    const modulos = new Set(Object.values(PERMISSIONS).map((p) => p.modulo));
    expect(modulos.size).toBe(8);
  });

  it("toda permissão tem modulo e label não-vazios", () => {
    for (const codigo of PERMISSAO_CODIGOS) {
      const p = PERMISSIONS[codigo];
      expect(p.modulo).toMatch(/\S/);
      expect(p.label).toMatch(/\S/);
    }
  });

  it("códigos seguem padrão modulo.acao", () => {
    for (const codigo of PERMISSAO_CODIGOS) {
      expect(codigo).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe("userCan", () => {
  const session = { permissoes: new Set(["compras.ver", "compras.executar"]) };

  it("retorna false quando session é null", () => {
    expect(userCan(null, "compras.ver")).toBe(false);
  });

  it("retorna true quando todas permissões estão no Set", () => {
    expect(userCan(session, "compras.ver")).toBe(true);
    expect(userCan(session, "compras.ver", "compras.executar")).toBe(true);
  });

  it("retorna false quando alguma permissão falta", () => {
    expect(userCan(session, "compras.ver", "pedidos.aprovar")).toBe(false);
  });

  it("retorna true quando required é vazio (vacuosamente verdadeiro)", () => {
    expect(userCan(session)).toBe(true);
  });
});

describe("userCanAny", () => {
  const session = { permissoes: new Set(["compras.ver"]) };

  it("retorna true quando qualquer permissão está no Set", () => {
    expect(userCanAny(session, "compras.ver", "pedidos.aprovar")).toBe(true);
  });

  it("retorna false quando nenhuma permissão está no Set", () => {
    expect(userCanAny(session, "pedidos.aprovar")).toBe(false);
  });

  it("retorna false quando session é null", () => {
    expect(userCanAny(null, "compras.ver")).toBe(false);
  });
});

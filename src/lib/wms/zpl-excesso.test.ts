import { describe, expect, it } from "vitest";
import { gerarZplExcesso, type EtiquetaExcessoInput } from "./zpl-excesso";

const BASE: EtiquetaExcessoInput = {
  sku: "192847",
  descricao: "Filtro de óleo",
  qty: 24,
  localizacao: "A-01-1",
  galpao: "CWB",
  data: "06/07/2026",
};

describe("gerarZplExcesso", () => {
  it("emite 1 folha 800×1200 com ^XA/^XZ", () => {
    const zpl = gerarZplExcesso(BASE);
    expect(zpl.match(/\^XA/g)?.length).toBe(1);
    expect(zpl.match(/\^XZ/g)?.length).toBe(1);
    expect(zpl).toContain("^PW800");
    expect(zpl).toContain("^LL1200");
    expect(zpl).toContain("^CI28");
  });

  it("carrega o SKU no QR e no CODE128 rotacionado", () => {
    const zpl = gerarZplExcesso(BASE);
    expect(zpl).toContain("^BQN,2,8^FDQA,192847^FS");
    expect(zpl).toMatch(/\^BCR,160,N,N,N\^FD192847\^FS/);
  });

  it("estampa a qty gigante (2 dígitos → font 330)", () => {
    const zpl = gerarZplExcesso(BASE);
    expect(zpl).toContain("^A0R,330,330^FB440,1,0,C^FD24^FS");
    expect(zpl).toContain("^FDEXCESSO^FS");
    expect(zpl).toContain("^FDUNIDADES^FS");
  });

  it("encolhe a fonte da qty conforme os dígitos", () => {
    expect(gerarZplExcesso({ ...BASE, qty: 128 })).toContain("^A0R,250,250");
    expect(gerarZplExcesso({ ...BASE, qty: 1024 })).toContain("^A0R,190,190");
    expect(gerarZplExcesso({ ...BASE, qty: 10500 })).toContain("^A0R,150,150");
  });

  it("clampa qty <= 0 ou fracionária pra inteiro >= 1", () => {
    expect(gerarZplExcesso({ ...BASE, qty: 0 })).toContain("^FD1^FS");
    expect(gerarZplExcesso({ ...BASE, qty: -3 })).toContain("^FD1^FS");
    expect(gerarZplExcesso({ ...BASE, qty: 2.9 })).toContain("^FD2^FS");
  });

  it("SKU curto sai em destaque (font 110); longo encolhe", () => {
    expect(gerarZplExcesso(BASE)).toContain("^A0R,110,110^FB660,1,0,C^FD192847^FS");
    const longo = gerarZplExcesso({ ...BASE, sku: "TEST-EXCESSO-XYZ" });
    expect(longo).toContain("^A0R,72,72^FB660,1,0,C^FDTEST-EXCESSO-XYZ^FS");
  });

  it("SKU nunca sobrescreve a si mesmo (largura estimada cabe em 660 dots)", () => {
    // ^FB de 1 linha não corta: o excedente é desenhado POR CIMA da linha.
    for (let len = 1; len <= 60; len++) {
      const sku = "X".repeat(len);
      const font = Number(
        gerarZplExcesso({ ...BASE, sku }).match(
          /\^A0R,(\d+),\d+\^FB660,1,0,C\^FD/,
        )![1],
      );
      expect(len * font * 0.55, `SKU de ${len}ch estoura a coluna`).toBeLessThanOrEqual(660);
    }
  });

  it("module width do barcode encolhe pra SKU longo", () => {
    expect(gerarZplExcesso(BASE)).toContain("^BY3,2,160");
    expect(gerarZplExcesso({ ...BASE, sku: "ABCDEFGHIJKL" })).toContain("^BY2,2,160");
    expect(gerarZplExcesso({ ...BASE, sku: "X".repeat(20) })).toContain("^BY1,2,160");
  });

  it("rodapé junta loc e galpão; sem galpão sai só a loc", () => {
    expect(gerarZplExcesso(BASE)).toContain("^FDA-01-1 · CWB^FS");
    const semGalpao = gerarZplExcesso({ ...BASE, galpao: undefined });
    expect(semGalpao).toContain("^FDA-01-1^FS");
    expect(gerarZplExcesso(BASE)).toContain("^FD06/07/2026^FS");
  });

  it("loc vazia vira travessão", () => {
    expect(gerarZplExcesso({ ...BASE, localizacao: "" })).toContain("^FD— · CWB^FS");
  });

  it("descrição longa encolhe a fonte; absurda é truncada com elipse", () => {
    const media = gerarZplExcesso({
      ...BASE,
      descricao:
        "COMPRESSOR AR COND. DENSO 10SRE18 GM CRUZE 1.4 TURBO 2017/2022 C/ POLIA 6PK",
    });
    expect(media).toMatch(/\^A0R,48,48\^FB660,4,0,L\^FD/);

    const absurda = gerarZplExcesso({ ...BASE, descricao: "X".repeat(200) });
    expect(absurda).toContain("X".repeat(132) + "…");
    expect(absurda).not.toContain("X".repeat(133));
  });

  it("limpa newlines do input pra não quebrar ZPL", () => {
    const zpl = gerarZplExcesso({
      ...BASE,
      sku: "X\n123",
      descricao: "linha 1\r\nlinha 2",
    });
    expect(zpl).not.toMatch(/\^FD[^\^]*\n[^\^]*\^FS/);
    expect(zpl).toContain("FDlinha 1 linha 2");
  });

  it("QR nunca embola com o CODE128, seja qual for o tamanho do SKU", () => {
    // Largura REAL do símbolo = módulos(versão) × magnificação. Versão vem da
    // capacidade em bytes (modo binário, correção Q) — tabela replicada aqui de
    // propósito: é ela que a impressora aplica, não o ^FO declarado.
    const MODULOS = [21, 25, 29, 33, 37, 41, 45, 49, 53, 57];
    const CAP_BYTES = [11, 20, 32, 46, 60, 74, 86, 108, 130, 151];

    // SKUs reais longos têm espaço/minúscula → o QR cai em modo BYTE, que
    // estoura a versão MUITO antes do modo alfanumérico. Era o caso que
    // embolava: 36 bytes = versão 4 = 264 dots na magnificação fixa antiga.
    const reais = [
      "MK-XB27BK-KIT-Q MK-175B LIMB MK-4BAL",
      "TELA Aparelho  1, 1a, 1+, 1a+ 1AAA",
      "K-XB21BK MK-CCS MK-RL MK-350Q-BK",
    ];
    const casos = [
      ...[1, 6, 8, 11, 12, 16, 20, 21, 25, 32, 33, 46, 60, 80].map((n) => "X".repeat(n)),
      ...reais,
    ];
    for (const sku of casos) {
      const len = sku.length;
      const zpl = gerarZplExcesso({ ...BASE, sku });

      const qrM = zpl.match(/\^FO(\d+),(\d+)\^BQN,2,(\d+)/);
      const barM = zpl.match(/\^FO(\d+),(\d+)\^BCR/);
      expect(qrM, `QR ausente pra len=${len}`).not.toBeNull();
      expect(barM, `barcode ausente pra len=${len}`).not.toBeNull();

      const idx = CAP_BYTES.findIndex((c) => len <= c);
      const modulos = MODULOS[idx === -1 ? MODULOS.length - 1 : idx];
      const mag = Number(qrM![3]);
      const qrLx = Number(qrM![2]);
      const barLx = Number(barM![2]);

      expect(mag, `mag ilegível pra len=${len}`).toBeGreaterThanOrEqual(4);
      expect(barLx, `QR embola no barcode pra len=${len}`).toBeGreaterThan(
        qrLx + modulos * mag,
      );
    }
  });

  it("SKU longo encolhe a magnificação do QR (cabe no orçamento)", () => {
    // 6 bytes → versão 1 (21 módulos) → mag 8 = 168 dots
    expect(gerarZplExcesso(BASE)).toContain("^BQN,2,8^FDQA,192847^FS");
    // 25 bytes → versão 3 (29 módulos) → mag 6 = 174 dots
    expect(gerarZplExcesso({ ...BASE, sku: "X".repeat(25) })).toContain("^BQN,2,6^FDQA,");
  });

  it("campos rotacionados ficam dentro da mídia (FO x em 0..800)", () => {
    const zpl = gerarZplExcesso({ ...BASE, qty: 99999, sku: "X".repeat(25) });
    const fos = [...zpl.matchAll(/\^FO(\d+),(\d+)/g)];
    expect(fos.length).toBeGreaterThan(5);
    for (const [, x, y] of fos) {
      expect(Number(x)).toBeGreaterThanOrEqual(0);
      expect(Number(x)).toBeLessThan(800);
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThan(1200);
    }
  });
});

const SMALL_PW = 800;
const SMALL_LL = 200;
const HALF = 400;

function clean(value: string): string {
  return value.replace(/[\r\n^~]+/g, " ").trim();
}

function pequenaMetade(codigo: string, x: number): string {
  const value = clean(codigo);
  return [
    `^CF0,48`,
    `^FO${x + 8},28^FB${HALF - 16},1,,C^FD${value}^FS`,
    `^FO${x + 145},88^BQN,2,4^FDQA,${value}^FS`,
  ].join("\n");
}

/** Mesma mídia da etiqueta de produto: duas posições por folha. */
export function gerarZplEnderecoPequena(codigos: string[]): string {
  const folhas: string[] = [];
  for (let i = 0; i < codigos.length; i += 2) {
    folhas.push([
      "^XA",
      "^CI28",
      `^PW${SMALL_PW}`,
      `^LL${SMALL_LL}`,
      pequenaMetade(codigos[i], 0),
      codigos[i + 1] ? pequenaMetade(codigos[i + 1], HALF) : "",
      "^XZ",
    ].filter(Boolean).join("\n"));
  }
  return folhas.join("\n");
}

/** Mídia 10×15 cm: texto dominante e QR da localização. */
export function gerarZplEnderecoGrande(codigos: string[]): string {
  return codigos.map((raw) => {
    const codigo = clean(raw);
    const font = codigo.length <= 12 ? 150 : codigo.length <= 18 ? 110 : 82;
    return [
      "^XA",
      "^CI28",
      "^PW800",
      "^LL1200",
      `^CF0,${font}`,
      `^FO35,110^FB730,2,,C^FD${codigo}^FS`,
      "^FO255,520^BQN,2,10",
      `^FDQA,${codigo}^FS`,
      "^XZ",
    ].join("\n");
  }).join("\n");
}

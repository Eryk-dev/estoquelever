/**
 * PrintNode stub layer (staging-only).
 *
 * Quando PRINTNODE_DISABLED=true, printnode.ts roteia chamadas pra cá em vez
 * de POST api.printnode.com. Comportamento:
 *   - testarConexao: retorna { ok: true, email: "stub@local" }
 *   - listarImpressoras: retorna 2 impressoras fake estáveis
 *   - enviarImpressao / enviarImpressaoZpl: guarda no buffer, retorna ID fake
 *
 * Cenários podem ler __getPrintJobs() pra asserir "etiqueta foi gerada".
 */

export function isPrintNodeDisabled(): boolean {
  return process.env.PRINTNODE_DISABLED === "true";
}

export interface PrintJobStub {
  id: string;
  tipo: "pdf" | "zpl";
  printerId: number;
  titulo: string;
  tamanhoBytes: number;
  enviadoEm: string;
}

const buffer: PrintJobStub[] = [];
let seq = 0;

function nextId(): string {
  seq += 1;
  return `printjob-${String(seq).padStart(4, "0")}`;
}

export function __getPrintJobs(): PrintJobStub[] {
  return [...buffer];
}

export function __resetPrintJobs(): void {
  buffer.length = 0;
  seq = 0;
}

export async function testarConexaoStub(): Promise<{ ok: true; email: string }> {
  return { ok: true, email: "stub@local" };
}

export async function listarImpressorasStub(): Promise<
  Array<{ id: number; name: string; computer: string; state: string }>
> {
  return [
    { id: 9001, name: "Stub Envio CWB", computer: "stub-pc", state: "online" },
    { id: 9002, name: "Stub Produto CWB", computer: "stub-pc", state: "online" },
  ];
}

export async function enviarImpressaoStub(params: {
  printerId: number;
  titulo: string;
  contentBase64: string;
}): Promise<{ id: string }> {
  const id = nextId();
  buffer.push({
    id,
    tipo: "pdf",
    printerId: params.printerId,
    titulo: params.titulo,
    tamanhoBytes: Buffer.from(params.contentBase64, "base64").length,
    enviadoEm: new Date().toISOString(),
  });
  return { id };
}

export async function enviarImpressaoZplStub(params: {
  printerId: number;
  titulo: string;
  zpl: string;
}): Promise<{ id: string }> {
  const id = nextId();
  buffer.push({
    id,
    tipo: "zpl",
    printerId: params.printerId,
    titulo: params.titulo,
    tamanhoBytes: Buffer.byteLength(params.zpl, "utf8"),
    enviadoEm: new Date().toISOString(),
  });
  return { id };
}

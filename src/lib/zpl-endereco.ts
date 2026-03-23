// ZPL generation for warehouse address labels

export interface EnderecoRange {
  corredorInicio: string
  corredorFim: string
  horizontalInicio: number
  horizontalFim: number
  verticalInicio: number
  verticalFim: number
}

/**
 * Returns a list of corridor values between start and end.
 * - Equal values → [start]
 * - Single letters (A–Z) → alphabetic range
 * - Numbers → numeric range
 * - Otherwise → [start]
 */
export function getCorridorRange(start: string, end: string): string[] {
  const s = String(start).trim().toUpperCase()
  const e = String(end).trim().toUpperCase()

  if (s === e) return [s]

  const startNum = parseInt(s, 10)
  const endNum = parseInt(e, 10)

  if (!isNaN(startNum) && !isNaN(endNum)) {
    const list: string[] = []
    const step = startNum <= endNum ? 1 : -1
    for (let n = startNum; step > 0 ? n <= endNum : n >= endNum; n += step) {
      list.push(String(n))
    }
    return list
  }

  if (s.length === 1 && e.length === 1 && /[A-Z]/.test(s) && /[A-Z]/.test(e)) {
    const list: string[] = []
    const startCode = s.charCodeAt(0)
    const endCode = e.charCodeAt(0)
    const step = startCode <= endCode ? 1 : -1
    for (let c = startCode; step > 0 ? c <= endCode : c >= endCode; c += step) {
      list.push(String.fromCharCode(c))
    }
    return list
  }

  return [s]
}

/**
 * Generates all address combinations from a range.
 * Format: CORRIDOR-HH-V (horizontal padStart 2 '0', vertical no pad)
 */
export function gerarEnderecos(range: EnderecoRange): string[] {
  const corridors = getCorridorRange(range.corredorInicio, range.corredorFim)
  const enderecos: string[] = []

  for (const corridor of corridors) {
    for (let h = range.horizontalInicio; h <= range.horizontalFim; h++) {
      for (let v = range.verticalInicio; v <= range.verticalFim; v++) {
        const hStr = String(h).padStart(2, '0')
        const vStr = String(v)
        enderecos.push(`${corridor}-${hStr}-${vStr}`)
      }
    }
  }

  return enderecos
}

/**
 * Generates ZPL for small labels (100mm × 23mm, 2 addresses per label).
 * Exact template from GERARSEMFIXA in scripts.js.
 */
export function gerarZplPequena(enderecos: string[]): string {
  let zpl = ''

  for (let i = 0; i < enderecos.length; i += 2) {
    const addr1 = enderecos[i]
    const addr2 = enderecos[i + 1]

    if (addr2) {
      // Two addresses per label
      zpl +=
        `^XA\n^PW812\n^LL184\n^CF0,70\n^LH0,0^FS\n` +
        `^FO10,30^FB400,1,,C^FD${addr1}^FS\n` +
        `^BY2,2,70\n^FO20,120^BCN,85,N,N,N^FD${addr1}^FS\n` +
        `^FO300,50^BQN,2,4^FDQA,${addr1}^FS\n` +
        `^FO450,30^FB400,1,,C^FD${addr2}^FS\n` +
        `^BY2,2,70\n^FO460,120^BCN,85,N,N,N^FD${addr2}^FS\n` +
        `^FO750,50^BQN,2,4^FDQA,${addr2}^FS\n` +
        `^XZ\n`
    } else {
      // Odd last label — single address
      zpl +=
        `^XA\n^PW812\n^LL184\n^CF0,70\n^LH0,0^FS\n` +
        `^FO10,30^FB400,1,,C^FD${addr1}^FS\n` +
        `^BY2,2,70\n^FO20,120^BCN,85,N,N,N^FD${addr1}^FS\n` +
        `^FO300,50^BQN,2,4^FDQA,${addr1}^FS\n` +
        `^XZ\n`
    }
  }

  return zpl
}

/**
 * Generates ZPL for large labels (4×6", 1 address per label, rotated 90°).
 * Exact template from GERARZPL_VERTICAL in scripts.js.
 */
export function gerarZplGrande(enderecos: string[]): string {
  let zpl = ''

  for (const addr of enderecos) {
    zpl +=
      `^XA\n` +
      `^FWR\n` +
      `^CF0,250\n` +
      `^LH0,0^FS\n` +
      `^FO450,0^FB1300,0,,C^FD${addr}^FS\n` +
      `^BY6,3,200\n` +
      `^FO50,100^BCR,200,N,N,N^FD${addr}^FS\n` +
      `^FO50,700^BQN,2,10^FDQA,${addr}^FS\n` +
      `^XZ\n`
  }

  return zpl
}

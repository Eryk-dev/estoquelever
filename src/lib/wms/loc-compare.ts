/** Comparação natural de códigos de localização (e.g. A-2 < A-10). */
export function naturalLocCompare(a: string, b: string): number {
  const segA = a.split(/(\d+)/);
  const segB = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(segA.length, segB.length); i++) {
    const pa = segA[i],
      pb = segB[i];
    const na = parseInt(pa, 10),
      nb = parseInt(pb, 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const c = pa.localeCompare(pb);
      if (c !== 0) return c;
    }
  }
  return segA.length - segB.length;
}

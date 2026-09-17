/** null for an empty list: "no data" must never read as a score of 0. */
export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function rate(hits: number, total: number): number | null {
  return total ? hits / total : null;
}

/** 95% Wilson score interval for hits/total; null when there is nothing to estimate from. */
export function wilson(hits: number, total: number, z = 1.96): [number, number] | null {
  if (total === 0) return null;
  const p = hits / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface Proportion {
  hits: number;
  total: number;
  rate: number | null;
  ci: [number, number] | null;
}

export function proportion(hits: number, total: number): Proportion {
  return { hits, total, rate: rate(hits, total), ci: wilson(hits, total) };
}

/** "50% 5/10 [24–76]": with a dozen cases the interval is the honest part of the number. */
export function formatProportion(p: Proportion): string {
  if (p.rate === null) return `— ${p.hits}/${p.total}`;
  const pct = (x: number) => String(Math.round(x * 100));
  return `${pct(p.rate)}% ${p.hits}/${p.total} [${pct(p.ci![0])}–${pct(p.ci![1])}]`;
}

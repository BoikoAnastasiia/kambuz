/** null for an empty list: "no data" must never read as a score of 0. */
export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function rate(hits: number, total: number): number | null {
  return total ? hits / total : null;
}

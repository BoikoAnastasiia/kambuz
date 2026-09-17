/** What one bench case cost: every API attempt its agent call made, retries included. */
export interface CaseUsage {
  model: string;
  calls: number;
  input: number;
  output: number;
  costUsd: number | null;
  /** Attempts billed by the API whose usage was lost (a parse failure the SDK threw): cost is a lower bound. */
  unbilled: number;
}

export interface VariantUsage {
  calls: number;
  input: number;
  output: number;
  costUsd: number | null;
  unbilled: number;
}

/** Per-variant totals from the per-case usage alone, so a saved report can be re-totalled. */
export function aggregateUsage(cases: Array<{ variant: string; usage?: CaseUsage }>, variants: string[]): Record<string, VariantUsage> {
  const out: Record<string, VariantUsage> = Object.fromEntries(variants.map((v) => [v, { calls: 0, input: 0, output: 0, costUsd: 0, unbilled: 0 }]));
  for (const c of cases) {
    const u = c.usage;
    const t = out[c.variant];
    if (!u || !t) continue;
    t.calls += u.calls;
    t.input += u.input;
    t.output += u.output;
    t.unbilled += u.unbilled ?? 0;
    t.costUsd = t.costUsd === null || u.costUsd === null ? null : t.costUsd + u.costUsd;
  }
  return out;
}

/**
 * A variant's cost as shown to a person: "—" when no call succeeded (a $0 there would read as
 * cheap rather than broken), and "≥" when some attempts could not be billed.
 */
export function variantCostLabel(u: VariantUsage, okCases: number, format: (n: number | null) => string): string {
  if (okCases === 0) return "—";
  return `${u.unbilled > 0 ? "≥" : ""}${format(u.costUsd)}`;
}

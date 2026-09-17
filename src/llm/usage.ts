import type { AgentName } from "../config.js";
import { costUsd } from "./pricing.js";

interface Bucket {
  input: number;
  output: number;
  calls: number;
  costUsd: number | null;
}

export interface UsageRow {
  agent: string;
  calls: number;
  input: number;
  output: number;
  costUsd: number | null;
}

type UsageListener = (agent: AgentName, model: string, usage: { input_tokens: number; output_tokens: number }) => void;

/** null poisons the sum: one call on an unknown model makes the whole total unknown, never 0. */
function addCost(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** 4 decimals under $1 (so a $0.0034 call doesn't round to $0.00), 2 above. "?" for an unknown cost. */
export function formatCost(cost: number | null): string {
  if (cost === null) return "?";
  return `$${cost.toFixed(Math.abs(cost) < 1 ? 4 : 2)}`;
}

export class UsageLedger {
  private buckets = new Map<string, Bucket>();
  private listeners = new Set<UsageListener>();

  add(agent: AgentName, model: string, usage: { input_tokens: number; output_tokens: number }): void {
    const b = this.buckets.get(agent) ?? { input: 0, output: 0, calls: 0, costUsd: 0 };
    b.input += usage.input_tokens;
    b.output += usage.output_tokens;
    b.calls += 1;
    b.costUsd = addCost(b.costUsd, costUsd(model, usage));
    this.buckets.set(agent, b);
    for (const listener of this.listeners) {
      try {
        listener(agent, model, usage);
      } catch {
        // a listener (e.g. the progress renderer) must never break token accounting
      }
    }
  }

  /** Notified on every add(); returns a function that unsubscribes. */
  subscribe(listener: UsageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  byAgent(): Record<string, Bucket> {
    return Object.fromEntries(this.buckets);
  }

  total(): Bucket {
    let t: Bucket = { input: 0, output: 0, calls: 0, costUsd: 0 };
    for (const b of this.buckets.values()) {
      t = { input: t.input + b.input, output: t.output + b.output, calls: t.calls + b.calls, costUsd: addCost(t.costUsd, b.costUsd) };
    }
    return t;
  }

  /** Structured per-agent rows for the HTML renderer (and toString() below), insertion order. */
  rows(): UsageRow[] {
    return [...this.buckets.entries()].map(([agent, b]) => ({ agent, calls: b.calls, input: b.input, output: b.output, costUsd: b.costUsd }));
  }

  toString(): string {
    const lines = this.rows().map(
      (r) =>
        `${r.agent.padEnd(12)} ${String(r.calls).padStart(4)} calls ${String(r.input).padStart(9)} in ${String(r.output).padStart(8)} out ${formatCost(r.costUsd).padStart(9)}`,
    );
    const t = this.total();
    lines.push(
      `${"total".padEnd(12)} ${String(t.calls).padStart(4)} calls ${String(t.input).padStart(9)} in ${String(t.output).padStart(8)} out ${formatCost(t.costUsd).padStart(9)}`,
    );
    return lines.join("\n");
  }
}

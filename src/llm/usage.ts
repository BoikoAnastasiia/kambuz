import type { AgentName } from "../config.js";

interface Bucket {
  input: number;
  output: number;
  calls: number;
}

type UsageListener = (agent: AgentName, model: string, usage: { input_tokens: number; output_tokens: number }) => void;

export class UsageLedger {
  private buckets = new Map<string, Bucket>();
  private listeners = new Set<UsageListener>();

  add(agent: AgentName, model: string, usage: { input_tokens: number; output_tokens: number }): void {
    const b = this.buckets.get(agent) ?? { input: 0, output: 0, calls: 0 };
    b.input += usage.input_tokens;
    b.output += usage.output_tokens;
    b.calls += 1;
    this.buckets.set(agent, b);
    void model; // kept for future per-model pricing
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
    let t: Bucket = { input: 0, output: 0, calls: 0 };
    for (const b of this.buckets.values()) {
      t = { input: t.input + b.input, output: t.output + b.output, calls: t.calls + b.calls };
    }
    return t;
  }

  toString(): string {
    const lines = [...this.buckets.entries()].map(
      ([a, b]) =>
        `${a.padEnd(12)} ${String(b.calls).padStart(4)} calls ${String(b.input).padStart(9)} in ${String(b.output).padStart(8)} out`,
    );
    const t = this.total();
    lines.push(
      `${"total".padEnd(12)} ${String(t.calls).padStart(4)} calls ${String(t.input).padStart(9)} in ${String(t.output).padStart(8)} out`,
    );
    return lines.join("\n");
  }
}

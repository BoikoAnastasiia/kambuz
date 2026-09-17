import { EFFORTS, isEffort, type Effort } from "../config.js";

/** One contender in a bench: a model, optionally at a thinking effort. `id` is how it was written. */
export interface Variant {
  id: string;
  model: string;
  effort?: Effort;
}

export type ParsedVariants = { ok: true; variants: Variant[] } | { ok: false; error: string };

/** `claude-sonnet-5,claude-sonnet-5:low,claude-haiku-4-5` → three variants, in order. */
export function parseVariants(raw: string): ParsedVariants {
  const entries = raw.split(",").map((e) => e.trim()).filter((e) => e !== "");
  if (entries.length === 0) return { ok: false, error: "--models needs at least one model[:effort]" };
  const variants: Variant[] = [];
  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length > 2) return { ok: false, error: `"${entry}": expected model[:effort]` };
    const [model, effort] = parts.map((p) => p.trim());
    if (!model) return { ok: false, error: `"${entry}": missing model` };
    if (effort !== undefined && !isEffort(effort)) {
      return { ok: false, error: `"${entry}": effort must be one of ${EFFORTS.join(", ")}` };
    }
    const variant: Variant = effort === undefined ? { id: model, model } : { id: `${model}:${effort}`, model, effort };
    if (variants.some((v) => v.id === variant.id)) return { ok: false, error: `"${variant.id}" is listed twice` };
    variants.push(variant);
  }
  return { ok: true, variants };
}

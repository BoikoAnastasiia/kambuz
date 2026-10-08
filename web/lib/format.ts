/** 506 → "8:26", 3725 → "1:02:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 80 → "1 h 20 min", 45 → "45 min" */
export function duration(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const METHODS: Record<string, string> = {
  bake: "baked", stew: "stewed", grill: "grilled", fry: "fried", boil: "boiled", steam: "steamed", raw: "raw", "no-cook": "no cooking",
};

export function methodLabel(method: string | null): string | null {
  return method ? (METHODS[method] ?? method) : null;
}

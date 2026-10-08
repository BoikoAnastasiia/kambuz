/** 506 → "8:26", 3725 → "1:02:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 80 → "1 ч 20 мин", 45 → "45 мин" */
export function duration(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${m} мин`;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Russian plural: plural(1, ["рецепт", "рецепта", "рецептов"]) → "рецепт", 3 → "рецепта", 11 → "рецептов". */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Same names as vocab/methods.json; kept here so client components needn't fetch the vocab.
const METHODS: Record<string, string> = {
  bake: "Запекание", stew: "Тушение", grill: "Гриль", fry: "Жарка", boil: "Варка",
  steam: "На пару", raw: "Без готовки", "no-cook": "Без термообработки",
};

export function methodLabel(method: string | null): string | null {
  return method ? (METHODS[method] ?? method) : null;
}

// The extractor writes units in English (see src/prompts/extractor.md, rule 3).
const UNITS: Record<string, string> = {
  g: "г", kg: "кг", ml: "мл", l: "л", pc: "шт.", tbsp: "ст. л.", tsp: "ч. л.",
  clove: "зуб.", pack: "уп.", pinch: "щепотка",
};

export function unitLabel(unit: string | null): string | null {
  return unit ? (UNITS[unit] ?? unit) : null;
}

const MEALS: Record<string, string> = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин" };

export function mealLabel(meal: string): string {
  return MEALS[meal] ?? meal;
}

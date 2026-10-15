// The site's two languages. Russian lives at the bare paths (/, /recipe/…), English under /en
// (see proxy.ts). Everything here is plain data, so client components can import it too.

export const LANGS = ["ru", "en"] as const;
export type Lang = (typeof LANGS)[number];

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

/** The cookie the language switch sets, so the proxy keeps the choice on the next visit. */
export const LANG_COOKIE = "lang";

/** "/recipe/x" in the given language: unchanged for Russian, "/en/recipe/x" for English. */
export function localePath(lang: Lang, path: string): string {
  if (lang === "ru") return path;
  return path === "/" ? "/en" : `/en${path}`;
}

/** The same page in the other language: "/en/recipe/x" ↔ "/recipe/x". */
export function switchPath(pathname: string, to: Lang): string {
  const bare = pathname === "/en" ? "/" : pathname.startsWith("/en/") ? pathname.slice(3) : pathname.startsWith("/ru/") ? pathname.slice(3) : pathname === "/ru" ? "/" : pathname;
  return localePath(to, bare);
}

const ru = {
  htmlTitle: "Kambuz — что на ужин?",
  htmlDescription: "Не знаешь, что приготовить? Выбери приём пищи и кухню — мы подберём блюдо.",
  title: "Что на ужин?",
  lede: "Не знаешь, что приготовить? Сейчас придумаем.",
  signIn: "Войти",
  addVideo: "+ Добавить видео",
  switchTo: "Switch to English",
  meals: { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", dessert: "Десерт" },
  filters: "Фильтры",
  meal: "Приём пищи",
  cuisine: "Кухня",
  anyCuisine: "Любая",
  mustHave: "Обязательные ингредиенты",
  anotherDish: "Другое блюдо",
  matches: (n: number) => `${plural(n, ["подходит", "подходят", "подходят"])} ${n} ${plural(n, ["рецепт", "рецепта", "рецептов"])}`,
  alsoFits: "Ещё подходят",
  nothingTitle: "Пока ничего не подходит",
  nothingBefore: "Попробуйте другую кухню или уберите часть обязательных ингредиентов — или ",
  nothingLink: "добавьте видео",
  nothingAfter: " с таким блюдом.",
  ingredients: "Ингредиенты",
  andMore: (n: number) => `и ещё ${n}`,
  openRecipe: "Открыть рецепт →",
  videoFrom: (t: string) => `▶ Видео с ${t}`,
  watchOnYoutube: "Смотреть на YouTube",
  removeIngredient: (name: string) => `Убрать: ${name}`,
  findIngredient: "Найти ингредиент",
  findPlaceholder: "Найти ингредиент — свинина, рис, сыр…",
  notInMatches: (q: string) => `В подходящих блюдах нет «${q}»`,
  nothingToAdd: "Больше нечего добавить — уберите что-нибудь или поищите",
  somethingWrong: "Что-то пошло не так",
  loadingRecipes: "Загружаем рецепты",
  loadingRecipe: "Загружаем рецепт",
  back: "← Назад",
  cuisineTag: (name: string) => `${name} кухня`,
  activeTime: "Активное время",
  totalTime: "Всего",
  servings: "Порций",
  whenToEat: "Когда есть",
  method: "Приготовление",
  amountUnknown: "количество не названо",
  fromVideo: "Из видео",
  watchFromDish: (title: string) => `Смотреть «${title}» с начала этого блюда`,
  untranslated: "",
};

export type Dict = typeof ru;

const en: Dict = {
  htmlTitle: "Kambuz — what to cook?",
  htmlDescription: "Out of ideas? Pick a meal and a cuisine, and we'll find you a dish.",
  title: "What to cook?",
  lede: "Out of ideas? Let's cook.",
  signIn: "Sign in",
  addVideo: "+ Add video",
  switchTo: "Переключить на русский",
  meals: { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", dessert: "Dessert" },
  filters: "Filters",
  meal: "Meal",
  cuisine: "Cuisine",
  anyCuisine: "Any",
  mustHave: "Must-have ingredients",
  anotherDish: "Another dish",
  matches: (n: number) => `${n} ${n === 1 ? "recipe matches" : "recipes match"}`,
  alsoFits: "These fit too",
  nothingTitle: "Nothing fits yet",
  nothingBefore: "Try another cuisine or drop some of the must-have ingredients — or ",
  nothingLink: "add a video",
  nothingAfter: " with a dish like that.",
  ingredients: "Ingredients",
  andMore: (n: number) => `and ${n} more`,
  openRecipe: "Open recipe →",
  videoFrom: (t: string) => `▶ Video from ${t}`,
  watchOnYoutube: "Watch on YouTube",
  removeIngredient: (name: string) => `Remove: ${name}`,
  findIngredient: "Find an ingredient",
  findPlaceholder: "Find an ingredient — pork, rice, cheese…",
  notInMatches: (q: string) => `None of the matching dishes have “${q}”`,
  nothingToAdd: "Nothing more to add — remove something or search",
  somethingWrong: "Something went wrong",
  loadingRecipes: "Loading recipes",
  loadingRecipe: "Loading the recipe",
  back: "← Back",
  cuisineTag: (name: string) => `${name} cuisine`,
  activeTime: "Active time",
  totalTime: "Total",
  servings: "Servings",
  whenToEat: "Good for",
  method: "Method",
  amountUnknown: "amount not given",
  fromVideo: "From the video",
  watchFromDish: (title: string) => `Watch “${title}” from the start of this dish`,
  untranslated: "This recipe hasn't been translated yet, so it's shown in the original Russian.",
};

export const DICTS: Record<Lang, Dict> = { ru, en };

/** Russian plural: plural(1, ["рецепт", "рецепта", "рецептов"]) → "рецепт", 3 → "рецепта", 11 → "рецептов". */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** 80 → "1 ч 20 мин" / "1 h 20 min", 45 → "45 мин" / "45 min" */
export function duration(minutes: number | null, lang: Lang): string | null {
  if (minutes === null || minutes <= 0) return null;
  const [hu, mu] = lang === "ru" ? ["ч", "мин"] : ["h", "min"];
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} ${hu}${m ? ` ${m} ${mu}` : ""}` : `${m} ${mu}`;
}

// Same ids as vocab/methods.json; kept here so client components needn't fetch the vocab.
const METHODS: Record<Lang, Record<string, string>> = {
  ru: {
    bake: "Запекание", stew: "Тушение", grill: "Гриль", fry: "Жарка", boil: "Варка",
    steam: "На пару", raw: "Без готовки", "no-cook": "Без термообработки",
  },
  en: {
    bake: "Baked", stew: "Stewed", grill: "Grilled", fry: "Fried", boil: "Boiled",
    steam: "Steamed", raw: "Raw", "no-cook": "No-cook",
  },
};

export function methodLabel(method: string | null, lang: Lang): string | null {
  return method ? (METHODS[lang][method] ?? method) : null;
}

// The extractor writes units in English (see src/prompts/extractor.md, rule 3).
const UNITS_RU: Record<string, string> = {
  g: "г", kg: "кг", ml: "мл", l: "л", pc: "шт.", tbsp: "ст. л.", tsp: "ч. л.",
  clove: "зуб.", pack: "уп.", pinch: "щепотка",
};
// [one, many]; a count of pieces needs no word in English ("2 eggs" reads from the name).
const UNITS_EN: Record<string, [string, string]> = {
  g: ["g", "g"], kg: ["kg", "kg"], ml: ["ml", "ml"], l: ["l", "l"], pc: ["", ""], tbsp: ["tbsp", "tbsp"], tsp: ["tsp", "tsp"],
  clove: ["clove", "cloves"], pack: ["pack", "packs"], pinch: ["pinch", "pinches"],
};

/** "1,5 ст. л." / "1.5 tbsp"; null when no quantity was given. */
export function amount(quantity: number | null, unit: string | null, lang: Lang): string | null {
  if (quantity === null) return null;
  const n = lang === "ru" ? String(quantity).replace(".", ",") : String(quantity);
  const u = !unit ? "" : lang === "ru" ? (UNITS_RU[unit] ?? unit) : (UNITS_EN[unit]?.[quantity === 1 ? 0 : 1] ?? unit);
  return u ? `${n} ${u}` : n;
}

// Visitors whose browser asks for one of these first get the Russian site; everyone else, English.
const RUSSIAN_READERS = ["ru", "uk", "be", "kk"];

/**
 * The language a visitor arriving at a bare path should see: the one they picked with the
 * switch if they did, else the first language their browser asks for. No header (a crawler,
 * a script) means Russian, the site's own language.
 */
export function preferredLang(cookie: string | undefined, acceptLanguage: string | null): Lang {
  if (cookie && isLang(cookie)) return cookie;
  const first = acceptLanguage
    ?.split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q)[0];
  if (!first) return "ru";
  return RUSSIAN_READERS.includes(first.tag.split("-")[0]) ? "ru" : "en";
}

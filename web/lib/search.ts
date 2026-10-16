// Free-text search over the recipes the filters already chose. A hundred-odd recipes fit in
// memory, so it's plain matching rather than a search index.

/** Lowercase, ё as е, letters and digits only. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * A query word cut down to what its forms share, so «пиццу» finds «пицца», «креветки» finds
 * «креветка» and "shrimps" finds "shrimp". Russian endings are one or two letters; short words
 * are kept whole, since «суп» cut to «су» would match half the catalog.
 */
export function stem(word: string): string {
  if (word.length >= 6) return word.slice(0, -2);
  if (word.length >= 4) return word.slice(0, -1);
  return word;
}

export interface Searchable {
  /** Dish names in every language: a Russian query should find an English-named dish too. */
  names: string[];
  ingredients: string[];
}

/** Each query word has to start some word of the dish; a match in the name counts more than one in the ingredients. 0 is no match. */
export function score(item: Searchable, query: string): number {
  const words = normalize(query).split(" ").filter(Boolean).map(stem);
  if (!words.length) return 0;
  const nameWords = item.names.flatMap((n) => normalize(n).split(" "));
  const ingredientWords = item.ingredients.flatMap((n) => normalize(n).split(" "));
  let total = 0;
  for (const w of words) {
    if (nameWords.some((x) => x.startsWith(w))) total += 3;
    else if (ingredientWords.some((x) => x.startsWith(w))) total += 1;
    else return 0;
  }
  return total;
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PickerOptions } from "@/lib/suggest";
import type { RecipeCard, Suggestion, VocabItem } from "@/lib/types";
import { capitalize, clock } from "@/lib/format";
import { DICTS, duration, localePath, methodLabel, type Dict, type Lang } from "@/lib/i18n";
import { watchUrl } from "@/lib/youtube";
import { MAIN_INGREDIENTS } from "@/lib/ingredients";
import styles from "./what-to-cook.module.css";

const MEALS = [
  { id: "breakfast", icon: "🍳" },
  { id: "lunch", icon: "🍲" },
  { id: "dinner", icon: "🍝" },
  { id: "dessert", icon: "🍰" },
  { id: "any", icon: "🍽️" },
] as const;

/** A vocabulary item's name in the page's language. */
function nameIn(item: VocabItem, lang: Lang): string {
  return lang === "ru" ? item.nameRu : item.nameEn;
}

type Meal = (typeof MEALS)[number]["id"];
type Menu = "meal" | "cuisine" | "ingredients";

// Typing waits this long before asking the server, so a word isn't searched letter by letter.
const SEARCH_DELAY_MS = 250;

export function WhatToCook({ lang, options, initial }: { lang: Lang; options: PickerOptions; initial: Suggestion }) {
  const t = DICTS[lang];
  // The meal the visitor chose, or null until they do. Until then a search looks at every meal,
  // so «сырники» are found from the dinner default, and clearing the search brings dinner back.
  const [chosenMeal, setChosenMeal] = useState<Meal | null>(null);
  const [cuisine, setCuisine] = useState("random");
  const [include, setInclude] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Menu | null>(null);
  const [result, setResult] = useState<Suggestion>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The filters the result on screen was fetched for; the server rendered the defaults.
  const shownFor = useRef("dinner|random||");
  // Only the newest request may change the screen: typing fires several, and they can answer out of order.
  const latest = useRef(0);
  const bar = useRef<HTMLDivElement>(null);

  const cuisineName = useMemo(() => new Map(options.cuisines.map((c) => [c.id, nameIn(c, lang)])), [options.cuisines, lang]);
  const ingredientById = useMemo(() => new Map(options.ingredients.map((i) => [i.id, i])), [options.ingredients]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const meal: Meal = chosenMeal ?? (q ? "any" : "dinner");

  // An open menu closes on a click anywhere outside the filter bar, or on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function load(exclude?: string) {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ meal, cuisine, lang });
    if (include.length) params.set("include", include.join(","));
    if (q) params.set("q", q);
    if (exclude) params.set("exclude", exclude);
    try {
      const res = await fetch(`/api/suggest?${params}`);
      const body = await res.json();
      if (request !== latest.current) return;
      if (!res.ok) throw new Error(body.error ?? t.somethingWrong);
      setResult(body as Suggestion);
    } catch (e) {
      if (request === latest.current) setError((e as Error).message);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }

  // Refetch only when the filters differ from what is shown. Comparing filters rather than
  // skipping the first run keeps this right when React runs effects twice in development.
  useEffect(() => {
    const key = `${meal}|${cuisine}|${include.join(",")}|${q}`;
    if (key === shownFor.current) return;
    shownFor.current = key;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meal, cuisine, include, q]);

  const toggle = (menu: Menu) => setOpen((o) => (o === menu ? null : menu));
  const mealIcon = MEALS.find((m) => m.id === meal)!.icon;

  return (
    <div className={styles.wrap}>
      <section className={styles.filters} aria-label={t.filters}>
        <div className={styles.bar} ref={bar}>
          <Dropdown label={t.meal} open={open === "meal"} onToggle={() => toggle("meal")} icon={mealIcon} value={t.meals[meal]}>
            <div className={styles.options} role="radiogroup" aria-label={t.meal}>
              {MEALS.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={meal === m.id}
                  className={styles.option}
                  onClick={() => {
                    setChosenMeal(m.id);
                    setOpen(null);
                  }}
                >
                  <span aria-hidden>{m.icon}</span> {t.meals[m.id]}
                </button>
              ))}
            </div>
          </Dropdown>

          <Dropdown
            label={t.cuisine}
            open={open === "cuisine"}
            onToggle={() => toggle("cuisine")}
            icon="🌍"
            value={cuisine === "random" ? t.anyCuisineButton : (cuisineName.get(cuisine) ?? cuisine)}
            active={cuisine !== "random"}
          >
            <div className={styles.options} role="radiogroup" aria-label={t.cuisine}>
              {[{ id: "random", label: `🎲 ${t.anyCuisine}` }, ...options.cuisines.map((c) => ({ id: c.id, label: nameIn(c, lang) }))].map((c) => (
                <button
                  key={c.id}
                  role="radio"
                  aria-checked={cuisine === c.id}
                  className={styles.option}
                  onClick={() => {
                    setCuisine(c.id);
                    setOpen(null);
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Dropdown>

          <Dropdown
            label={t.mustHave}
            open={open === "ingredients"}
            onToggle={() => toggle("ingredients")}
            icon="🧄"
            value={include.length ? `${t.ingredientsButton} (${include.length})` : t.ingredientsButton}
            active={include.length > 0}
            wide
          >
            {/* Stays open while ingredients are added, so several can be picked in a row. */}
            <IngredientPicker
              lang={lang}
              all={options.ingredients}
              available={result.available}
              selected={include}
              byId={ingredientById}
              onAdd={(id) => setInclude((xs) => (xs.includes(id) ? xs : [...xs, id]))}
              onRemove={(id) => setInclude((xs) => xs.filter((x) => x !== id))}
            />
          </Dropdown>
        </div>

        <div className={styles.searchBox}>
          <span className={styles.searchIcon} aria-hidden>🔍</span>
          <input
            className={styles.dishSearch}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchLabel}
          />
          {query && (
            <button className={styles.clear} onClick={() => setQuery("")} aria-label={t.clearSearch}>
              ×
            </button>
          )}
        </div>
      </section>

      {error && <p className="empty">{error}</p>}

      <section aria-live="polite" className={loading ? styles.loading : undefined}>
        {result.results ? (
          <SearchResults lang={lang} t={t} q={q} results={result.results} total={result.total} cuisineName={cuisineName} />
        ) : result.pick ? (
          <>
            <PickCard lang={lang} t={t} card={result.pick} cuisineName={cuisineName.get(result.pick.cuisine)} />
            <div className={styles.reroll}>
              <button className="btn btn-ghost" disabled={loading || result.total < 2} onClick={() => load(result.pick?.id)}>
                ↻ {t.anotherDish}
              </button>
              <span className="label">{t.matches(result.total)}</span>
            </div>
            {result.others.length > 0 && (
              <div className={styles.others}>
                <h2 className={styles.othersTitle}>{t.alsoFits}</h2>
                <DishList lang={lang} cards={result.others} cuisineName={cuisineName} />
              </div>
            )}
          </>
        ) : (
          <div className={styles.none}>
            <p className={styles.noneTitle}>{t.nothingTitle}</p>
            <p>
              {t.nothingBefore}
              <Link href={localePath(lang, "/add")}>{t.nothingLink}</Link>
              {t.nothingAfter}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/** A filter button showing its current choice; its panel opens under the whole bar, so it never runs off a phone screen. */
function Dropdown({
  label, icon, value, open, onToggle, active, wide, children,
}: {
  label: string;
  icon: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  active?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.dropdown}>
      <button
        className={`${styles.trigger} ${active ? styles.triggerActive : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`${label}: ${value}`}
        onClick={onToggle}
      >
        <span aria-hidden>{icon}</span>
        <span>{value}</span>
        <span className={styles.caret} aria-hidden>▾</span>
      </button>
      {open && <div className={`${styles.panel} ${wide ? styles.panelWide : ""}`}>{children}</div>}
    </div>
  );
}

function DishList({ lang, cards, cuisineName }: { lang: Lang; cards: RecipeCard[]; cuisineName: Map<string, string> }) {
  return (
    <ul className={styles.otherList}>
      {cards.map((o) => (
        <li key={o.id}>
          <Link href={localePath(lang, `/recipe/${o.id}`)} className={styles.other}>
            <span className={styles.otherName}>{o.name}</span>
            <span className={styles.otherMeta}>{[cuisineName.get(o.cuisine), duration(o.totalMinutes, lang)].filter(Boolean).join(" · ")}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SearchResults({
  lang, t, q, results, total, cuisineName,
}: {
  lang: Lang;
  t: Dict;
  q: string;
  results: RecipeCard[];
  total: number;
  cuisineName: Map<string, string>;
}) {
  if (!results.length) {
    return (
      <div className={styles.none}>
        <p className={styles.noneTitle}>{t.nothingFound(q)}</p>
        <p>{t.nothingFoundHint}</p>
      </div>
    );
  }
  return (
    <div>
      <h2 className={styles.othersTitle}>{t.found(total)}</h2>
      <DishList lang={lang} cards={results} cuisineName={cuisineName} />
      {total > results.length && <p className="label">{t.foundMore(results.length)}</p>}
    </div>
  );
}

function PickCard({ lang, t, card, cuisineName }: { lang: Lang; t: Dict; card: RecipeCard; cuisineName?: string }) {
  const meta = [cuisineName, methodLabel(card.method, lang), duration(card.totalMinutes, lang)].filter(Boolean) as string[];
  const shown = card.ingredients.slice(0, 8);
  const more = card.ingredients.length - shown.length;
  return (
    <article className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.metaRow}>
          {meta.map((m, i) => (
            <span key={m} className={i === 0 ? styles.tagRed : i === 1 ? styles.tagMustard : styles.tagHerb}>
              {capitalize(m)}
            </span>
          ))}
        </div>
        <h2 className={styles.dish}>{card.name}</h2>
        <p className="label">{t.ingredients}</p>
        <ul className={styles.ingredients}>
          {shown.map((name, i) => (
            <li key={`${name}-${i}`}>{name}</li>
          ))}
          {more > 0 && <li className={styles.more}>{t.andMore(more)}</li>}
        </ul>
        <div className={styles.actions}>
          <Link href={localePath(lang, `/recipe/${card.id}`)} className="btn">
            {t.openRecipe}
          </Link>
          <a href={watchUrl(card.videoId, card.segmentStart)} target="_blank" rel="noreferrer" className="btn btn-ghost">
            {t.videoFrom(clock(card.segmentStart))}
          </a>
        </div>
      </div>
      <a href={watchUrl(card.videoId, card.segmentStart)} target="_blank" rel="noreferrer" className={styles.thumb} aria-label={t.watchOnYoutube}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* maxresdefault is 16:9 with no letterbox bars but missing on some older videos; mqdefault always exists and is 16:9 too. */}
        <img
          key={card.videoId}
          src={`https://i.ytimg.com/vi/${card.videoId}/maxresdefault.jpg`}
          alt=""
          onError={(e) => fallBack(e.currentTarget, card.videoId)}
          // A missing maxres thumbnail can also come back as a 120px grey placeholder rather than an error.
          onLoad={(e) => e.currentTarget.naturalWidth <= 120 && fallBack(e.currentTarget, card.videoId)}
        />
        <span className={styles.play} aria-hidden>
          ▶
        </span>
      </a>
    </article>
  );
}

function fallBack(img: HTMLImageElement, videoId: string) {
  if (!img.src.endsWith("/mqdefault.jpg")) img.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function IngredientPicker({
  lang, all, available, selected, byId, onAdd, onRemove,
}: {
  lang: Lang;
  all: VocabItem[];
  available: Record<string, number>;
  selected: string[];
  byId: Map<string, VocabItem>;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = DICTS[lang];
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // Only what the dishes on offer contain, so adding an ingredient never empties the result.
  // Before typing, the main ingredients by how many dishes have them; typing searches the rest too.
  const nameOf = (id: string) => {
    const item = byId.get(id);
    return item ? nameIn(item, lang) : id;
  };
  const matches = all
    .filter((i) => available[i.id] && !selected.includes(i.id))
    .filter((i) => (q ? i.nameRu.toLowerCase().includes(q) || i.nameEn.toLowerCase().includes(q) : MAIN_INGREDIENTS.has(i.id)))
    .sort((a, b) => (q ? 0 : available[b.id] - available[a.id]))
    .slice(0, q ? 12 : 18);

  return (
    <div className={styles.picker}>
      {selected.length > 0 && (
        <ul className={styles.selected} aria-label={t.mustHave}>
          {selected.map((id) => (
            <li key={id}>
              <button className={styles.selectedChip} onClick={() => onRemove(id)} aria-label={t.removeIngredient(nameOf(id))}>
                {nameOf(id)} <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        className={styles.search}
        type="search"
        placeholder={t.findPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) {
            onAdd(matches[0].id);
            setQuery("");
          }
        }}
        aria-label={t.findIngredient}
      />
      <ul className={styles.suggestions}>
        {matches.map((i) => (
          <li key={i.id}>
            <button
              className={styles.suggestion}
              onClick={() => {
                onAdd(i.id);
                setQuery("");
              }}
            >
              + {nameIn(i, lang)} <span className={styles.count}>{available[i.id]}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && (
          <li className={styles.ru}>{q ? t.notInMatches(query) : t.nothingToAdd}</li>
        )}
      </ul>
    </div>
  );
}

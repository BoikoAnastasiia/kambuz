"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PickerOptions } from "@/lib/suggest";
import type { RecipeCard, Suggestion, VocabItem } from "@/lib/types";
import { capitalize, clock, duration, methodLabel, plural } from "@/lib/format";
import { watchUrl } from "@/lib/youtube";
import styles from "./what-to-cook.module.css";

const MEALS = [
  { id: "breakfast", label: "Завтрак", icon: "🍳" },
  { id: "lunch", label: "Обед", icon: "🍲" },
  { id: "dinner", label: "Ужин", icon: "🍝" },
  { id: "dessert", label: "Десерт", icon: "🍰" },
] as const;

type Meal = (typeof MEALS)[number]["id"];

export function WhatToCook({ options, initial }: { options: PickerOptions; initial: Suggestion }) {
  const [meal, setMeal] = useState<Meal>("dinner");
  const [cuisine, setCuisine] = useState("random");
  const [include, setInclude] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<Suggestion>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The filters the result on screen was fetched for; the server rendered the defaults.
  const shownFor = useRef("dinner|random|");

  const cuisineName = useMemo(() => new Map(options.cuisines.map((c) => [c.id, c.nameRu])), [options.cuisines]);
  const ingredientById = useMemo(() => new Map(options.ingredients.map((i) => [i.id, i])), [options.ingredients]);

  async function load(exclude?: string) {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ meal, cuisine });
    if (include.length) q.set("include", include.join(","));
    if (exclude) q.set("exclude", exclude);
    try {
      const res = await fetch(`/api/suggest?${q}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Что-то пошло не так");
      setResult(body as Suggestion);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Refetch only when the filters differ from what is shown. Comparing filters rather than
  // skipping the first run keeps this right when React runs effects twice in development.
  useEffect(() => {
    const key = `${meal}|${cuisine}|${include.join(",")}`;
    if (key === shownFor.current) return;
    shownFor.current = key;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meal, cuisine, include]);

  return (
    <div className={styles.wrap}>
      <section className={styles.filters} aria-label="Фильтры">
        {/* The meal is the main choice, exactly one of four: a segmented control. */}
        <div className={styles.segmented} role="radiogroup" aria-label="Приём пищи">
          {MEALS.map((m) => (
            <button key={m.id} role="radio" aria-checked={meal === m.id} className={styles.segment} onClick={() => setMeal(m.id)}>
              <span className={styles.segmentIcon} aria-hidden>{m.icon}</span>
              {m.label}
            </button>
          ))}
        </div>
        {/* Cuisine refines it: smaller, quieter chips under a label, selected in ink rather than red. */}
        <div className={styles.cuisineGroup}>
          <span className="label" id="cuisine-label">Кухня</span>
          <div className={`${styles.row} ${styles.scroll}`} role="radiogroup" aria-labelledby="cuisine-label">
            <button role="radio" aria-checked={cuisine === "random"} className={styles.small} onClick={() => setCuisine("random")}>
              🎲 Любая
            </button>
            {options.cuisines.map((c) => (
              <button key={c.id} role="radio" aria-checked={cuisine === c.id} className={styles.small} onClick={() => setCuisine(c.id)}>
                {c.nameRu}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.advanced}>
          <button className={styles.advancedToggle} aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
            <span aria-hidden>{advanced ? "▾" : "▸"}</span> Обязательные ингредиенты{include.length ? ` (${include.length})` : ""}
          </button>
          {advanced && (
            <IngredientPicker
              all={options.ingredients}
              selected={include}
              byId={ingredientById}
              onAdd={(id) => setInclude((xs) => (xs.includes(id) ? xs : [...xs, id]))}
              onRemove={(id) => setInclude((xs) => xs.filter((x) => x !== id))}
            />
          )}
        </div>
      </section>

      {error && <p className="empty">{error}</p>}

      <section aria-live="polite" className={loading ? styles.loading : undefined}>
        {result.pick ? (
          <>
            <PickCard card={result.pick} cuisineName={cuisineName.get(result.pick.cuisine)} />
            <div className={styles.reroll}>
              <button className="btn btn-ghost" disabled={loading || result.total < 2} onClick={() => load(result.pick?.id)}>
                ↻ Другое блюдо
              </button>
              <span className="label">
                {plural(result.total, ["подходит", "подходят", "подходят"])} {result.total} {plural(result.total, ["рецепт", "рецепта", "рецептов"])}
              </span>
            </div>
            {result.others.length > 0 && (
              <div className={styles.others}>
                <h2 className={styles.othersTitle}>Ещё подходят</h2>
                <ul className={styles.otherList}>
                  {result.others.map((o) => (
                    <li key={o.id}>
                      <Link href={`/recipe/${o.id}`} className={styles.other}>
                        <span className={styles.otherName}>{o.nameRu}</span>
                        <span className={styles.otherMeta}>
                          {[cuisineName.get(o.cuisine), duration(o.totalMinutes)].filter(Boolean).join(" · ")}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div className={styles.none}>
            <p className={styles.noneTitle}>Пока ничего не подходит</p>
            <p>
              Попробуйте другую кухню или уберите часть обязательных ингредиентов — или <Link href="/add">добавьте видео</Link> с таким блюдом.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function PickCard({ card, cuisineName }: { card: RecipeCard; cuisineName?: string }) {
  const meta = [cuisineName, methodLabel(card.method), duration(card.totalMinutes)].filter(Boolean) as string[];
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
        <h2 className={styles.dish}>{card.nameRu}</h2>
        <p className="label">Ингредиенты</p>
        <ul className={styles.ingredients}>
          {shown.map((name, i) => (
            <li key={`${name}-${i}`}>{name}</li>
          ))}
          {more > 0 && <li className={styles.more}>и ещё {more}</li>}
        </ul>
        <div className={styles.actions}>
          <Link href={`/recipe/${card.id}`} className="btn">
            Открыть рецепт →
          </Link>
          <a href={watchUrl(card.videoId, card.segmentStart)} target="_blank" rel="noreferrer" className="btn btn-ghost">
            ▶ Видео с {clock(card.segmentStart)}
          </a>
        </div>
      </div>
      <a href={watchUrl(card.videoId, card.segmentStart)} target="_blank" rel="noreferrer" className={styles.thumb} aria-label="Смотреть на YouTube">
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
  all, selected, byId, onAdd, onRemove,
}: {
  all: VocabItem[];
  selected: string[];
  byId: Map<string, VocabItem>;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = all
    .filter((i) => !selected.includes(i.id))
    .filter((i) => !q || i.nameRu.toLowerCase().includes(q) || i.nameEn.toLowerCase().includes(q))
    .slice(0, q ? 12 : 18);

  return (
    <div className={styles.picker}>
      {selected.length > 0 && (
        <ul className={styles.selected} aria-label="Обязательные ингредиенты">
          {selected.map((id) => (
            <li key={id}>
              <button className={styles.selectedChip} onClick={() => onRemove(id)} aria-label={`Убрать: ${byId.get(id)?.nameRu ?? id}`}>
                {byId.get(id)?.nameRu ?? id} <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        className={styles.search}
        type="search"
        placeholder="Найти ингредиент — картофель, курица…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches[0]) {
            onAdd(matches[0].id);
            setQuery("");
          }
        }}
        aria-label="Найти ингредиент"
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
              + {i.nameRu}
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className={styles.ru}>Нет ингредиента «{query}»</li>}
      </ul>
    </div>
  );
}

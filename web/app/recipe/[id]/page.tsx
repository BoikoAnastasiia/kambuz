import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { collections } from "@/lib/db";
import { capitalize, clock, duration, methodLabel } from "@/lib/format";
import { watchUrl } from "@/lib/youtube";
import type { Ingredient } from "@/lib/types";
import { VideoEmbed } from "@/components/VideoEmbed";
import styles from "./recipe.module.css";

// The extractor's notes mix what the chef said («немного говядины») with remarks about its
// own vocabulary lookup, which mean nothing to someone cooking.
const PIPELINE_NOTE = /словар|vocab/i;

function amount(i: Ingredient): string | null {
  if (i.quantity === null) return null;
  return [i.quantity, i.unit].filter((x) => x !== null && x !== "").join(" ");
}

async function RecipeView({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const { recipes, vocab } = await collections();
  const [recipe, cuisines] = await Promise.all([recipes.findOne({ _id: id }), vocab.findOne({ _id: "cuisines" })]);
  if (!recipe) notFound();

  const cuisine = cuisines?.items.find((c) => c.id === recipe.cuisine)?.nameEn;
  const tags = [cuisine && cuisine !== "Other" ? cuisine : null, recipe.course, methodLabel(recipe.method)].filter(Boolean) as string[];
  const stats = [
    { label: "Active time", value: duration(recipe.activeMinutes) },
    { label: "Total time", value: duration(recipe.totalMinutes) },
    { label: "Servings", value: recipe.servings ? String(recipe.servings) : null },
    { label: "Meals", value: recipe.mealTypes.map(capitalize).join(", ") },
  ].filter((s) => s.value);
  const start = recipe.source.segmentStart;

  return (
    <article className={styles.recipe}>
      <Link href="/" className={styles.back}>← What to cook</Link>

      <header className={styles.head}>
        <div className={styles.tags}>
          {tags.map((t) => (
            <span key={t} className={styles.tag}>{capitalize(t)}</span>
          ))}
        </div>
        <h1 className={styles.title}>{recipe.nameRu}</h1>
        <p className={styles.titleEn}>{recipe.nameEn}</p>
        <dl className={styles.stats}>
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="label">{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <VideoEmbed videoId={recipe.source.videoId} start={start} title={recipe.source.videoTitle} />

      <div className={styles.columns}>
        <section className={styles.ingredients}>
          <h2 className={styles.h2}>Ingredients</h2>
          <ul>
            {recipe.ingredients.map((i, n) => (
              <li key={`${i.rawName}-${n}`}>
                <span className={styles.ingName}>{capitalize(i.baseName ?? i.rawName)}</span>
                {amount(i) ? <span className={styles.ingAmount}>{amount(i)}</span> : <span className={styles.ingUnknown}>amount not said</span>}
                {i.note && !PIPELINE_NOTE.test(i.note) && <span className={styles.ingNote}>{i.note}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.steps}>
          <h2 className={styles.h2}>Directions</h2>
          <ol>
            {recipe.steps.map((s) => (
              <li key={s.order}>
                <span className={styles.stepNo}>{s.order}</span>
                <p>
                  {s.text}{" "}
                  <a className={styles.ts} href={watchUrl(recipe.source.videoId, s.timestamp)} target="_blank" rel="noreferrer">
                    ▶ {clock(s.timestamp)}
                  </a>
                </p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <footer className={styles.source}>
        From <a href={watchUrl(recipe.source.videoId, start)} target="_blank" rel="noreferrer">{recipe.source.videoTitle}</a>
        {recipe.source.channel ? ` · ${recipe.source.channel}` : ""}
      </footer>
    </article>
  );
}

export default function RecipePage({ params }: PageProps<"/recipe/[id]">) {
  return (
    <Suspense fallback={<p className="empty">Fetching the recipe…</p>}>
      <RecipeView params={params} />
    </Suspense>
  );
}

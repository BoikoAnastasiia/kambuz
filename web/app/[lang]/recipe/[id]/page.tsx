import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lang } from "next/root-params";
import { collections } from "@/lib/db";
import { capitalize, clock } from "@/lib/format";
import { DICTS, amount, duration, isLang, localePath, methodLabel, type Lang } from "@/lib/i18n";
import { watchUrl } from "@/lib/youtube";
import type { RecipeDoc, VocabItem } from "@/lib/types";
import { VideoEmbed } from "@/components/VideoEmbed";
import { RecipeSkeleton } from "@/components/Skeletons";
import styles from "./recipe.module.css";

// The extractor's notes mix what the chef said («немного говядины») with remarks about its
// own vocabulary lookup, which mean nothing to someone cooking. The English notes were
// cleaned of those by the translator.
const PIPELINE_NOTE = /словар|vocab/i;

interface Line {
  name: string;
  amount: string | null;
  note: string | null;
}

/**
 * The ingredient lines and steps in the page's language. English uses the accepted translation;
 * a recipe without one falls back to the Russian, which the page then says.
 */
function content(recipe: RecipeDoc, lang: Lang): { ingredients: Line[]; steps: string[]; translated: boolean } {
  const en = lang === "en" ? recipe.en : undefined;
  const ingredients = recipe.ingredients.map((i, k) => {
    const tr = en?.ingredients[k];
    const note = tr ? tr.note : i.note && !PIPELINE_NOTE.test(i.note) ? i.note : null;
    return { name: capitalize(tr?.name ?? i.baseName ?? i.rawName), amount: amount(i.quantity, i.unit, en ? "en" : "ru"), note };
  });
  const steps = recipe.steps.map((s, k) => en?.steps[k] ?? s.text);
  return { ingredients, steps, translated: lang === "ru" || !!en };
}

function vocabName(items: VocabItem[] | undefined, id: string, lang: Lang): string | undefined {
  const item = items?.find((c) => c.id === id);
  return item && (lang === "ru" ? item.nameRu : item.nameEn);
}

async function RecipeView({ params }: { params: Promise<{ lang: string; id: string }> }) {
  await connection();
  const { lang: rawLang, id } = await params;
  if (!isLang(rawLang)) notFound();
  const lang: Lang = rawLang;
  const t = DICTS[lang];
  const { recipes, vocab } = await collections();
  const [recipe, cuisines, courses] = await Promise.all([
    recipes.findOne({ _id: id }),
    vocab.findOne({ _id: "cuisines" }),
    vocab.findOne({ _id: "courses" }),
  ]);
  if (!recipe) notFound();

  const cuisine = recipe.cuisine === "other" ? null : vocabName(cuisines?.items, recipe.cuisine, lang);
  const course = vocabName(courses?.items, recipe.course, lang) ?? recipe.course;
  const tags = [cuisine ? t.cuisineTag(cuisine) : null, course, methodLabel(recipe.method, lang)].filter(Boolean) as string[];
  const stats = [
    { label: t.activeTime, value: duration(recipe.activeMinutes, lang) },
    { label: t.totalTime, value: duration(recipe.totalMinutes, lang) },
    { label: t.servings, value: recipe.servings ? String(recipe.servings) : null },
    { label: t.whenToEat, value: recipe.mealTypes.map((m) => t.meals[m]).join(", ") },
  ].filter((s) => s.value);
  const start = recipe.source.segmentStart;
  const { ingredients, steps, translated } = content(recipe, lang);

  return (
    <article className={styles.recipe}>
      <Link href={localePath(lang, "/")} className={styles.back}>{t.back}</Link>

      <header className={styles.head}>
        <div className={styles.tags}>
          {tags.map((tag) => (
            <span key={tag} className={styles.tag}>{capitalize(tag)}</span>
          ))}
        </div>
        <h1 className={styles.title}>{lang === "ru" ? recipe.nameRu : recipe.nameEn}</h1>
        <dl className={styles.stats}>
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="label">{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
        {!translated && <p className={styles.langNote}>{t.untranslated}</p>}
      </header>

      <VideoEmbed lang={lang} videoId={recipe.source.videoId} start={start} title={recipe.source.videoTitle} />

      <div className={styles.columns}>
        <section className={styles.ingredients} lang={translated ? undefined : "ru"}>
          <h2 className={styles.h2}>{t.ingredients}</h2>
          <ul>
            {ingredients.map((i, n) => (
              <li key={`${i.name}-${n}`}>
                <span className={styles.ingName}>{i.name}</span>
                {i.amount ? <span className={styles.ingAmount}>{i.amount}</span> : <span className={styles.ingUnknown}>{t.amountUnknown}</span>}
                {i.note && <span className={styles.ingNote}>{i.note}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.steps} lang={translated ? undefined : "ru"}>
          <h2 className={styles.h2}>{t.method}</h2>
          <ol>
            {recipe.steps.map((s, k) => (
              <li key={s.order}>
                <span className={styles.stepNo}>{s.order}</span>
                <p>
                  {steps[k]}{" "}
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
        {t.fromVideo} <a href={watchUrl(recipe.source.videoId, start)} target="_blank" rel="noreferrer">{recipe.source.videoTitle}</a>
        {recipe.source.channel ? ` · ${recipe.source.channel}` : ""}
      </footer>
    </article>
  );
}

export default async function RecipePage({ params }: PageProps<"/[lang]/recipe/[id]">) {
  // The root param is known before the page renders; awaiting `params` here would also wait on
  // the recipe id and hold the whole page back from the skeleton.
  const l = await lang();
  return (
    <Suspense fallback={<RecipeSkeleton lang={isLang(l) ? l : "ru"} />}>
      <RecipeView params={params} />
    </Suspense>
  );
}

import { DICTS, type Lang } from "@/lib/i18n";
import styles from "./skeleton.module.css";

function Block({ className, width }: { className?: string; width?: number | string }) {
  return <span className={`${styles.block} ${className ?? ""}`} style={width !== undefined ? { width } : undefined} />;
}

// Fixed widths rather than random ones: the server and the browser must render the same.
const PILL_WIDTHS = [120, 176, 168];
const INGREDIENT_WIDTHS = [70, 96, 64, 88, 120, 74, 92, 66];

/** The home picker while recipes load: the three filter buttons, the search box and a card. */
export function PickerSkeleton({ lang }: { lang: Lang }) {
  return (
    <div className={styles.picker} aria-busy="true" aria-label={DICTS[lang].loadingRecipes}>
      <div className={styles.filters}>
        <div className={styles.bar}>
          {PILL_WIDTHS.map((w, i) => (
            <Block key={i} className={styles.pill} width={w} />
          ))}
        </div>
        <Block className={styles.searchBar} />
      </div>
      <CardSkeleton />
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.tags}>
          <Block className={styles.tag} />
          <Block className={styles.tag} width={64} />
        </div>
        <Block className={styles.title} />
        <Block className={styles.titleShort} />
        <Block className={styles.small} />
        <div className={styles.chips}>
          {INGREDIENT_WIDTHS.map((w, i) => (
            <Block key={i} className={styles.ingredient} width={w} />
          ))}
        </div>
        <div className={styles.actions}>
          <Block className={styles.button} />
          <Block className={styles.button} width={150} />
        </div>
      </div>
      <Block className={styles.thumb} />
    </div>
  );
}

/** The recipe page while it loads: title, stats, video, ingredients and steps. */
export function RecipeSkeleton({ lang }: { lang: Lang }) {
  return (
    <div className={styles.recipe} aria-busy="true" aria-label={DICTS[lang].loadingRecipe}>
      <Block className={styles.back} />
      <div className={styles.tags}>
        <Block className={styles.tag} width={120} />
        <Block className={styles.tag} width={110} />
        <Block className={styles.tag} width={96} />
      </div>
      <Block className={styles.title} />
      <Block className={styles.titleShort} />
      <div className={styles.stats}>
        {[0, 1, 2].map((i) => (
          <Block key={i} className={styles.stat} />
        ))}
      </div>
      <Block className={styles.video} />
      <div className={styles.columns}>
        <div className={styles.panel}>
          {Array.from({ length: 7 }, (_, i) => (
            <Block key={i} className={styles.line} />
          ))}
        </div>
        <div className={styles.panel}>
          {Array.from({ length: 6 }, (_, i) => (
            <Block key={i} className={styles.line} width={`${92 - (i % 3) * 14}%`} />
          ))}
        </div>
      </div>
    </div>
  );
}

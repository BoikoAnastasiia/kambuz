import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { MissingDatabaseError } from "@/lib/db";
import { pickerOptions, suggest } from "@/lib/suggest";
import { DICTS, isLang, type Lang } from "@/lib/i18n";
import { WhatToCook } from "@/components/WhatToCook";
import { PickerSkeleton } from "@/components/Skeletons";
import styles from "./home.module.css";

async function Picker({ lang }: { lang: Lang }) {
  await connection();
  try {
    const [options, initial] = await Promise.all([pickerOptions(lang), suggest({ meal: "dinner", cuisine: "random", include: [] }, lang)]);
    return <WhatToCook lang={lang} options={options} initial={initial} />;
  } catch (e) {
    if (e instanceof MissingDatabaseError) return <p className="empty">{e.message}</p>;
    throw e;
  }
}

export default async function Home({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = DICTS[lang];
  return (
    <>
      <h1 className={styles.title}>{t.title}</h1>
      <p className={styles.lede}>{t.lede}</p>
      <Suspense fallback={<PickerSkeleton lang={lang} />}>
        <Picker lang={lang} />
      </Suspense>
    </>
  );
}

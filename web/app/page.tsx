import { Suspense } from "react";
import { connection } from "next/server";
import { MissingDatabaseError } from "@/lib/db";
import { pickerOptions, suggest } from "@/lib/suggest";
import { WhatToCook } from "@/components/WhatToCook";
import styles from "./home.module.css";

async function Picker() {
  await connection();
  try {
    const [options, initial] = await Promise.all([pickerOptions(), suggest({ meal: "dinner", cuisine: "random", include: [] })]);
    return <WhatToCook options={options} initial={initial} />;
  } catch (e) {
    if (e instanceof MissingDatabaseError) return <p className="empty">{e.message}</p>;
    throw e;
  }
}

export default function Home() {
  return (
    <>
      <h1 className={styles.title}>
        What to cook?
      </h1>
      <p className={styles.lede}>Выберите приём пищи и кухню — блюдо подберём мы.</p>
      <Suspense fallback={<p className="empty">Заглядываем на камбуз…</p>}>
        <Picker />
      </Suspense>
    </>
  );
}

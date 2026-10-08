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
        What to cook<span className={styles.q}>?</span>
      </h1>
      <p className={styles.lede}>Pick a meal and a cuisine — we&rsquo;ll pick the dish.</p>
      <Suspense fallback={<p className="empty">Looking in the galley…</p>}>
        <Picker />
      </Suspense>
    </>
  );
}

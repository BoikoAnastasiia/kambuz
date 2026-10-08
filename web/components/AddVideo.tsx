"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./add-video.module.css";

type RecipeLink = { id: string; nameRu: string };

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "invalid"; message: string }
  | { kind: "exists"; title: string; recipes: RecipeLink[] }
  | { kind: "job"; jobId: string; status: "queued" | "running" | "done" | "error"; progress: string[]; recipes: RecipeLink[]; error: string | null; since: number };

export function AddVideo() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "sending" });
    const res = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    const body = await res.json().catch(() => ({ error: "Сервер не ответил." }));
    if (!res.ok) return setState({ kind: "invalid", message: body.error ?? "Что-то пошло не так" });
    if (body.status === "exists") return setState({ kind: "exists", title: body.title, recipes: body.recipes });
    setState({ kind: "job", jobId: body.jobId, status: "queued", progress: [], recipes: [], error: null, since: Date.now() });
  }

  const jobId = state.kind === "job" ? state.jobId : null;
  const finished = state.kind === "job" && (state.status === "done" || state.status === "error");

  // Poll the job until the worker closes it.
  useEffect(() => {
    if (!jobId || finished) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) return;
      const job = await res.json();
      setState((s) => (s.kind === "job" && s.jobId === jobId ? { ...s, status: job.status, progress: job.progress, recipes: job.recipes, error: job.error } : s));
    }, 2000);
    return () => clearInterval(t);
  }, [jobId, finished]);

  const busy = state.kind === "sending" || (state.kind === "job" && !finished);

  return (
    <div className={styles.wrap}>
      <form className={styles.form} onSubmit={submit}>
        <input
          className={styles.input}
          type="url"
          required
          placeholder="https://www.youtube.com/watch?v=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          aria-label="Ссылка на YouTube"
        />
        <button className="btn" disabled={busy || !url.trim()}>
          {busy ? "Готовим…" : "Разобрать"}
        </button>
      </form>

      {state.kind === "invalid" && <p className={styles.error}>{state.message}</p>}

      {state.kind === "exists" && (
        <div className={styles.panel}>
          <p className={styles.panelTitle}>Уже есть на камбузе</p>
          <p className={styles.muted}>«{state.title}» уже разобрано{state.recipes.length ? ":" : ", но рецептов из него не получилось."}</p>
          <RecipeList recipes={state.recipes} />
        </div>
      )}

      {state.kind === "job" && (
        <div className={styles.panel}>
          <p className={styles.panelTitle}>
            {state.status === "queued" && "Ждёт своей очереди"}
            {state.status === "running" && "Разбираем видео"}
            {state.status === "done" && (state.recipes.length ? "Готово!" : "Готово — но рецептов нет")}
            {state.status === "error" && "Не получилось"}
          </p>
          {state.status === "queued" && Date.now() - state.since > 8000 && (
            <p className={styles.muted}>
              Видео пока никто не взял в работу. Запущен ли воркер? Запустите <code>npm run kambuz -- worker</code> в корне проекта.
            </p>
          )}
          <ol className={styles.progress}>
            {state.progress.map((line, i) => (
              <li key={i} className={i === state.progress.length - 1 && !finished ? styles.current : undefined}>
                {line}
              </li>
            ))}
          </ol>
          {state.error && <p className={styles.error}>{state.error}</p>}
          {state.status === "done" && <RecipeList recipes={state.recipes} />}
          {finished && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setUrl("");
                setState({ kind: "idle" });
              }}
            >
              Добавить ещё
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RecipeList({ recipes }: { recipes: RecipeLink[] }) {
  if (!recipes.length) return null;
  return (
    <ul className={styles.recipes}>
      {recipes.map((r) => (
        <li key={r.id}>
          <Link href={`/recipe/${r.id}`}>{r.nameRu} →</Link>
        </li>
      ))}
    </ul>
  );
}

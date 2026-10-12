"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AdminStatus as Status, JobStatus } from "@/lib/types";
import { plural } from "@/lib/format";
import styles from "./admin-status.module.css";

const POLL_MS = 5000;

const STATUS: Record<JobStatus, { label: string; tone: string }> = {
  queued: { label: "В очереди", tone: styles.queued },
  running: { label: "Обрабатывается", tone: styles.running },
  done: { label: "Готово", tone: styles.done },
  error: { label: "Ошибка", tone: styles.failed },
};

/** "только что", "5 мин назад", "3 ч назад", then a date. */
function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "только что";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function usd(n: number | null): string {
  if (n === null) return "";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** Live view of the worker and the job queue, for the admin under the add form. */
export function AdminStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/admin/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Status;
        if (!cancelled) {
          setStatus(body);
          setFailed(false);
          setNow(Date.now());
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!status) {
    return <section className={styles.panel}>{failed ? <p className={styles.muted}>Не удалось загрузить состояние.</p> : <p className={styles.muted}>Загружаем состояние…</p>}</section>;
  }

  const { worker, queued, jobs, totals } = status;

  return (
    <section className={styles.panel} aria-label="Панель администратора">
      <div className={`${styles.worker} ${worker.online ? styles.workerOn : styles.workerOff}`}>
        <span className={styles.dot} aria-hidden />
        <div>
          <p className={styles.workerTitle}>{worker.online ? "Воркер работает" : "Воркер не запущен"}</p>
          {worker.online ? (
            <p className={styles.muted}>
              {worker.currentJob ? "Сейчас разбирает видео" : "Ждёт новых видео"}
              {worker.host ? ` · ${worker.host}` : ""}
            </p>
          ) : (
            <p className={styles.muted}>
              {worker.lastSeen ? `Последний раз на связи ${ago(worker.lastSeen, now)}. ` : ""}
              Видео из очереди обработаются, когда вы запустите <code>npm run kambuz -- worker</code> в папке kambuz на своём компьютере.
            </p>
          )}
        </div>
        {queued > 0 && (
          <span className={styles.queueCount}>
            {queued} {plural(queued, ["видео ждёт", "видео ждут", "видео ждут"])}
          </span>
        )}
      </div>

      <dl className={styles.totals}>
        <div>
          <dt className="label">Рецептов</dt>
          <dd>{totals.recipes}</dd>
        </div>
        <div>
          <dt className="label">Видео</dt>
          <dd>{totals.videos}</dd>
        </div>
        <div>
          <dt className="label">Потрачено через сайт</dt>
          <dd>{usd(totals.spentUsd) || "$0.00"}</dd>
        </div>
      </dl>

      <h2 className={styles.h2}>Последние видео</h2>
      {jobs.length === 0 ? (
        <p className={styles.muted}>Пока ничего не добавлено через сайт.</p>
      ) : (
        <ul className={styles.jobs}>
          {jobs.map((j) => (
            <li key={j.id} className={styles.job}>
              {j.videoId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.thumb} src={`https://i.ytimg.com/vi/${j.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
              ) : (
                <span className={styles.thumb} />
              )}
              <div className={styles.jobBody}>
                <div className={styles.jobHead}>
                  <span className={`${styles.chip} ${STATUS[j.status].tone}`}>{STATUS[j.status].label}</span>
                  <span className={styles.muted}>{ago(j.createdAt, now)}</span>
                  {j.costUsd !== null && <span className={styles.muted}>· {usd(j.costUsd)}</span>}
                </div>
                <a className={styles.url} href={j.url} target="_blank" rel="noreferrer">
                  {j.url.replace(/^https:\/\/(www\.)?/, "")}
                </a>
                {j.status === "error" && j.error && <p className={styles.error}>{j.error}</p>}
                {j.status === "running" && j.lastProgress && <p className={styles.muted}>{j.lastProgress}…</p>}
                {j.recipes.length > 0 && (
                  <p className={styles.recipes}>
                    {j.recipes.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && " · "}
                        <Link href={`/recipe/${r.id}`}>{r.nameRu}</Link>
                      </span>
                    ))}
                  </p>
                )}
                {j.status === "done" && j.recipes.length === 0 && <p className={styles.muted}>Рецептов не получилось.</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

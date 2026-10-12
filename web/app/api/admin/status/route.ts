import { connection } from "next/server";
import { currentRole } from "@/auth";
import { collections } from "@/lib/db";
import { videoIdFrom } from "@/lib/youtube";
import type { AdminStatus } from "@/lib/types";

/** The worker reports every 10 s; two missed reports and it counts as offline. */
const ONLINE_WITHIN_MS = 25_000;

export async function GET() {
  await connection();
  if ((await currentRole()).role !== "admin") return Response.json({ error: "Только для администратора." }, { status: 403 });

  const { jobs, recipes, videos, workers } = await collections();
  const [worker, recent, queued, recipeCount, videoCount, spent] = await Promise.all([
    workers.find().sort({ lastSeen: -1 }).limit(1).next(),
    jobs.find().sort({ createdAt: -1 }).limit(10).toArray(),
    jobs.countDocuments({ status: "queued" }),
    recipes.countDocuments({ archived: false }),
    videos.countDocuments(),
    jobs.aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: { $ifNull: ["$costUsd", 0] } } } }]).toArray(),
  ]);

  const ids = [...new Set(recent.flatMap((j) => j.recipes))];
  const names = new Map(
    (ids.length ? await recipes.find({ id: { $in: ids }, archived: false }, { projection: { id: 1, nameRu: 1 } }).toArray() : []).map((r) => [r.id, r.nameRu]),
  );

  const online = !!worker && !worker.stoppedAt && Date.now() - Date.parse(worker.lastSeen) < ONLINE_WITHIN_MS;
  const body: AdminStatus = {
    worker: { online, host: worker?._id ?? null, lastSeen: worker?.lastSeen ?? null, currentJob: online ? worker!.currentJob : null },
    queued,
    jobs: recent.map((j) => ({
      id: j._id.toHexString(),
      url: j.url,
      videoId: videoIdFrom(j.url),
      status: j.status,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      lastProgress: j.progress.at(-1) ?? null,
      error: j.error,
      costUsd: j.costUsd,
      recipes: j.recipes.filter((id) => names.has(id)).map((id) => ({ id, nameRu: names.get(id)! })),
    })),
    totals: { recipes: recipeCount, videos: videoCount, spentUsd: spent[0]?.total ?? 0 },
  };
  return Response.json(body);
}

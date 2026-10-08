import { ObjectId } from "mongodb";
import { collections } from "@/lib/db";
import { videoIdFrom, watchUrl } from "@/lib/youtube";

/**
 * Queues one video for the worker. A video already in the database isn't queued again
 * (it would cost money to produce what is already there), and a second paste of a video
 * that is still in the queue joins the existing job.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
  const videoId = typeof body?.url === "string" ? videoIdFrom(body.url) : null;
  if (!videoId) {
    return Response.json({ error: "Вставьте ссылку на одно видео с YouTube (youtube.com/watch?v=… или youtu.be/…)." }, { status: 400 });
  }
  const { jobs, videos, recipes } = await collections();
  const url = watchUrl(videoId);

  const seen = await videos.findOne({ _id: videoId });
  if (seen && seen.status === "done") {
    const existing = await recipes.find({ archived: false, "source.videoId": videoId }, { projection: { id: 1, nameRu: 1 } }).toArray();
    return Response.json({ status: "exists", videoId, title: seen.title, recipes: existing.map((r) => ({ id: r.id, nameRu: r.nameRu })) });
  }

  const active = await jobs.findOne({ url, status: { $in: ["queued", "running"] } });
  if (active) return Response.json({ status: "queued", jobId: active._id.toHexString() });

  const _id = new ObjectId();
  await jobs.insertOne({
    _id, url, status: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    progress: [], recipes: [], error: null, costUsd: null,
  });
  return Response.json({ status: "queued", jobId: _id.toHexString() }, { status: 201 });
}

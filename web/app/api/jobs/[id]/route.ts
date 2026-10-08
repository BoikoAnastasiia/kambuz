import { ObjectId } from "mongodb";
import { connection } from "next/server";
import { collections } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!ObjectId.isValid(id)) return Response.json({ error: "No such job" }, { status: 404 });
  const { jobs, recipes } = await collections();
  const job = await jobs.findOne({ _id: new ObjectId(id) });
  if (!job) return Response.json({ error: "No such job" }, { status: 404 });
  const written = job.recipes.length
    ? await recipes.find({ id: { $in: job.recipes }, archived: false }, { projection: { id: 1, nameRu: 1 } }).toArray()
    : [];
  return Response.json({
    status: job.status,
    url: job.url,
    progress: job.progress,
    error: job.error,
    costUsd: job.costUsd,
    recipes: written.map((r) => ({ id: r.id, nameRu: r.nameRu })),
  });
}

import { ObjectId } from "mongodb";
import { connection } from "next/server";
import { collections } from "@/lib/db";
import { currentRole } from "@/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  if ((await currentRole()).role !== "admin") return Response.json({ error: "Только для администратора." }, { status: 403 });
  const { id } = await params;
  if (!ObjectId.isValid(id)) return Response.json({ error: "Задача не найдена" }, { status: 404 });
  const { jobs, recipes } = await collections();
  const job = await jobs.findOne({ _id: new ObjectId(id) });
  if (!job) return Response.json({ error: "Задача не найдена" }, { status: 404 });
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

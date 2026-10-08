import { connection, type NextRequest } from "next/server";
import { MissingDatabaseError } from "@/lib/db";
import { parseFilters, suggest } from "@/lib/suggest";

export async function GET(request: NextRequest) {
  await connection();
  const params = request.nextUrl.searchParams;
  try {
    return Response.json(await suggest(parseFilters(params), params.get("exclude") ?? undefined));
  } catch (e) {
    const status = e instanceof MissingDatabaseError ? 503 : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}

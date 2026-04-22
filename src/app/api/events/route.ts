import { getRecentEvents } from "@/server/db/queries/events";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? "20");

  try {
    const events = await getRecentEvents(limit);
    return Response.json(events);
  } catch {
    return Response.json([]);
  }
}

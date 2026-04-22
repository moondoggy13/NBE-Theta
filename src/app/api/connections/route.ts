import { checkConnections } from "@/server/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const connections = await checkConnections();
    return Response.json(connections);
  } catch {
    return Response.json([]);
  }
}

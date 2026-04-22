import { getTrades } from "@/server/db/queries/trades";
import { mockTrades } from "@/data/mock-portfolio";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const trades = await getTrades();
    return Response.json(trades.length ? trades : mockTrades);
  } catch {
    return Response.json(mockTrades);
  }
}

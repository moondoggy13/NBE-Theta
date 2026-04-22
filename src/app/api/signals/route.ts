import { getSignalsForToday } from "@/server/db/queries/signals";
import { mockSignals } from "@/data/mock-signals";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const signals = await getSignalsForToday();
    return Response.json(signals.length ? signals : mockSignals);
  } catch {
    return Response.json(mockSignals);
  }
}

import { getRiskMetrics } from "@/server/db/queries/risk";
import { mockRiskMetrics } from "@/data/mock-risk";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const metrics = await getRiskMetrics();
    return Response.json(metrics ?? mockRiskMetrics);
  } catch {
    return Response.json(mockRiskMetrics);
  }
}

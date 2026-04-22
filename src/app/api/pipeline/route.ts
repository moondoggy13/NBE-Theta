import { getPipelineStagesForToday } from "@/server/db/queries/pipeline";
import { getMockPipelineStages } from "@/data/mock-pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stages = await getPipelineStagesForToday();
    // If no DB rows exist, the query still returns 7 stages (all pending)
    // Use mock if all are pending (DB not seeded)
    const hasActivity = stages.some((s) => s.status !== "pending");
    return Response.json(hasActivity ? stages : getMockPipelineStages());
  } catch {
    return Response.json(getMockPipelineStages());
  }
}

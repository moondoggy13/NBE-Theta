import { getPortfolioSummary, getPositions } from "@/server/db/queries/portfolio";
import { mockPortfolioSummary, mockPositions } from "@/data/mock-portfolio";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [summary, positions] = await Promise.all([
      getPortfolioSummary(),
      getPositions(),
    ]);
    return Response.json({
      summary: summary ?? mockPortfolioSummary,
      positions: positions.length ? positions : mockPositions,
    });
  } catch {
    return Response.json({
      summary: mockPortfolioSummary,
      positions: mockPositions,
    });
  }
}

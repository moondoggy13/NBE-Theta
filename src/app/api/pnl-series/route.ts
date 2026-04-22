import { supabase } from "@/server/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!supabase) throw new Error("no db");
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from("pnl_snapshots")
      .select("captured_at, pnl_dollars")
      .eq("run_date", today)
      .order("captured_at", { ascending: true });

    if (data?.length) {
      return Response.json(
        data.map((row) => ({
          time: new Date(row.captured_at).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "America/New_York",
          }),
          pnl: Number(row.pnl_dollars),
        }))
      );
    }
    throw new Error("no data");
  } catch {
    // Return mock intraday data as fallback
    return Response.json([
      { time: "09:30", pnl: 0 },
      { time: "10:00", pnl: 15 },
      { time: "10:30", pnl: -8 },
      { time: "11:00", pnl: 22 },
      { time: "11:30", pnl: 35 },
      { time: "12:00", pnl: 28 },
      { time: "12:30", pnl: 42 },
      { time: "13:00", pnl: 55 },
      { time: "13:30", pnl: 48 },
      { time: "14:00", pnl: 62 },
      { time: "14:30", pnl: 58 },
      { time: "15:00", pnl: 68 },
      { time: "15:30", pnl: 72 },
    ]);
  }
}

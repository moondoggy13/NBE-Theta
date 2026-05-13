import { NextResponse } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/supabase/client";

/**
 * Action-log ingest from the agent-host.
 *
 * Every skill the driver invokes — open ticket, set qty, read ticket,
 * review_and_submit, etc. — POSTs here as one row. The dashboard then
 * subscribes to `agent_actions` via realtime and renders the live feed.
 *
 * Why ingest through the dashboard rather than host-to-Supabase direct:
 * the host should only need outbound HTTPS to one origin (the dashboard).
 * That makes locking it down to the trading PC straightforward and
 * keeps the service-role key out of the host.
 */
const ActionRow = z.object({
  taskId: z.string().optional(),
  clientOrderId: z.string().optional(),
  skill: z.string().min(1),
  args: z.unknown().optional(),
  reasoning: z.string().optional(),
  screenshotUrl: z.string().url().optional(),
  result: z.unknown().optional(),
});

export async function POST(req: Request) {
  const expected = process.env.COMPUTER_USE_HOST_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, reason: "host token not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const parsed = ActionRow.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: parsed.error.message }, { status: 400 });
  }
  const sb = serverClient();
  if (!sb) {
    return NextResponse.json({ ok: false, reason: "supabase not configured" }, { status: 503 });
  }
  const a = parsed.data;
  const { error } = await sb.from("agent_actions").insert({
    task_id: a.taskId,
    client_order_id: a.clientOrderId,
    skill: a.skill,
    args: a.args ?? null,
    reasoning: a.reasoning ?? null,
    screenshot_url: a.screenshotUrl ?? null,
    result: a.result ?? null,
  });
  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

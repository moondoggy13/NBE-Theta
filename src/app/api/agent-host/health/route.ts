import { NextResponse } from "next/server";

/**
 * Server-side proxy for the agent-host /healthz endpoint.
 *
 * The host typically runs on the trading workstation, not the same box as
 * the dashboard, and is bound to loopback. This route lets the browser
 * poll for liveness without exposing the host token client-side.
 */
export async function GET() {
  const url = process.env.COMPUTER_USE_HOST_URL;
  const token = process.env.COMPUTER_USE_HOST_TOKEN;
  if (!url || !token) {
    return NextResponse.json(
      { ok: false, reason: "agent-host not configured" },
      { status: 200 },
    );
  }
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) {
      return NextResponse.json({ ok: false, reason: `host status ${r.status}` });
    }
    const data = (await r.json()) as Record<string, unknown>;
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json({ ok: false, reason: String(err) });
  }
}

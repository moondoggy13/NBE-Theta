import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/auth";

/**
 * Who am I, and what am I allowed to do?
 *
 * The console needs this before it renders anything: a viewer should not
 * be shown a live-mode button that will refuse them, and an operator
 * should be able to see at a glance that they are signed in as
 * themselves rather than holding a shared secret.
 *
 * **The UI hiding a control is not the control.** Every route enforces
 * its own role server-side; this endpoint only lets the console avoid
 * offering actions it knows will fail. A caller who ignores it and posts
 * directly is refused exactly as before.
 *
 * Requires only `viewer`, because "what am I" is the one question every
 * authenticated caller may ask about themselves.
 */
export async function GET(req: Request) {
  const auth = await requireOperator(req, { role: "viewer" });
  if (!auth.ok) return auth.response;

  const p = auth.principal;
  return NextResponse.json({
    ok: true,
    identity: {
      userId: p.userId,
      email: p.email,
      role: p.role,
      method: p.method,
      label: p.label,
      // Surfaced so the console can say plainly that a shared credential
      // is in use. It is a transitional mechanism (ADR-0004) and it
      // should look like one rather than like normal operation.
      sharedCredential: p.method === "shared_token",
    },
  });
}

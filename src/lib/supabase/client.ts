/**
 * Supabase client factories. Lazy, env-driven.
 *
 *   serverClient() - service-role key for worker + server code
 *   browserClient() - anon key for dashboard (App Router client components)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _server: SupabaseClient | null = null;
let _browser: SupabaseClient | null = null;

export function serverClient(): SupabaseClient | null {
  if (_server) return _server;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _server = createClient(url, key, { auth: { persistSession: false } });
  return _server;
}

export function browserClient(): SupabaseClient | null {
  if (_browser) return _browser;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _browser = createClient(url, key);
  return _browser;
}

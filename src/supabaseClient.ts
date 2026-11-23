import { createClient } from "@supabase/supabase-js";

// This application talks ONLY to the dedicated Lottery Ball Supabase project. The legacy Wheel of
// Fortune variable names (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY) are intentionally ignored.
const supabaseUrl = import.meta.env.VITE_LOTTERY_SUPABASE_URL?.trim();
const supabasePublishableKey = import.meta.env.VITE_LOTTERY_SUPABASE_PUBLISHABLE_KEY?.trim();

const hasSupabaseConfig = Boolean(supabaseUrl || supabasePublishableKey);
let validSupabaseUrl = false;

if (supabaseUrl) {
  try {
    const parsedUrl = new URL(supabaseUrl);
    validSupabaseUrl = (parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:") && !!parsedUrl.hostname;
  } catch {
    validSupabaseUrl = false;
  }
}

const configuredSupabaseUrl = validSupabaseUrl ? supabaseUrl! : null;
const configuredPublishableKey = supabasePublishableKey || null;

export const supabaseConfigurationError = hasSupabaseConfig && (!configuredSupabaseUrl || !configuredPublishableKey)
  ? "Supabase is configured incorrectly. Set VITE_LOTTERY_SUPABASE_URL to the full Project URL of the lottery-ball-system project " +
    "(for example, https://your-project-ref.supabase.co) and VITE_LOTTERY_SUPABASE_PUBLISHABLE_KEY to its publishable key, then rebuild and redeploy."
  : null;

export const supabase = configuredSupabaseUrl && configuredPublishableKey
  ? createClient(configuredSupabaseUrl, configuredPublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "lottery-ball-system-auth",
    },
  })
  : null;

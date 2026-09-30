import { createClient } from "@supabase/supabase-js";

// Service-role client. Bypasses RLS entirely -- that's intentional, since
// all protection logic (watermark-only responses, timer enforcement,
// signed URLs) lives here in backend routes, not in open Supabase
// policies. Never expose this key to the frontend.
export const supabaseAdmin = createClient(
    process.env.PROJECT_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

export const BUCKETS = {
    originals: "project-originals", // private
    previews: "project-previews",   // public
    avatars: "avatars",             // public
    postImages: "post-images",      // public
};
import { supabaseAdmin } from "../lib/supabaseAdmin.js";

// Verifies the Supabase access token the frontend sends after login
// (Authorization: Bearer <token>) and attaches the real user to req.user.
// Everything behind this can trust req.user.id is a logged-in creative.
export async function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: "Missing access token." });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
        return res.status(401).json({ error: "Invalid or expired session." });
    }

    req.user = data.user;
    next();
}
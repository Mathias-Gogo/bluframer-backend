import { supabaseAdmin } from "./supabaseAdmin.js";
import { isUuid } from "./validate.js";
import { BadRequestError } from "./errors.js";

/**
 * The clock for a timed project starts the moment a given visitor is
 * FIRST actually served this project (not when the link is copied, not on
 * page-load of anything else) and is tracked here, server-side, in
 * project_views -- a table the client can't read or write directly. This
 * is what makes the timer real: a client can recompute its own countdown
 * for display, but it can never reset or extend the deadline, and this
 * function is the single place that decides whether images get served.
 *
 * Returns { remainingSeconds: number, expired: boolean }, or
 * { remainingSeconds: null, expired: false } when the project has no timer.
 */
export async function checkViewTimer(projectId, visitorId, timerMinutes) {
    if (!timerMinutes) return { remainingSeconds: null, expired: false };

    if (!isUuid(visitorId)) {
        throw new BadRequestError("A valid visitor_id is required for a timed project.");
    }

    let startedAt = await getViewStart(projectId, visitorId);
    if (!startedAt) startedAt = await createViewStart(projectId, visitorId);

    const elapsedSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;
    const remainingSeconds = Math.max(0, Math.round(timerMinutes * 60 - elapsedSeconds));
    return { remainingSeconds, expired: remainingSeconds <= 0 };
}

async function getViewStart(projectId, visitorId) {
    const { data } = await supabaseAdmin
        .from("project_views")
        .select("started_at")
        .eq("project_id", projectId)
        .eq("visitor_id", visitorId)
        .single();
    return data?.started_at ?? null;
}

async function createViewStart(projectId, visitorId) {
    const startedAt = new Date().toISOString();
    const { error } = await supabaseAdmin
        .from("project_views")
        .insert({ project_id: projectId, visitor_id: visitorId, started_at: startedAt });

    if (!error) return startedAt;

    // Two requests from the same new visitor arriving at once (e.g. the page
    // loading several images in parallel) will race here -- exactly one
    // insert wins, and this handles the loser by reading back the winner's
    // timestamp instead of erroring or, worse, silently starting a second,
    // later clock for the same visitor.
    if (error.code === "23505") {
        const existing = await getViewStart(projectId, visitorId);
        if (existing) return existing;
    }
    throw error;
}
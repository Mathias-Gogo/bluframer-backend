import { BadRequestError } from "./errors.js";

const MAX_TIMER_MINUTES = 60 * 24 * 30; // 30 days

// undefined/null/"" all mean "no timer". Anything else must be a whole
// number in range -- previously a typo like "abc" quietly became null and
// silently removed the timer, which is the wrong failure mode for a
// protection setting.
export function parseTimerMinutes(value) {
    if (value === undefined || value === null || value === "" || value === "null") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TIMER_MINUTES) {
        throw new BadRequestError(`Viewing timer must be a whole number of minutes between 1 and ${MAX_TIMER_MINUTES}.`);
    }
    return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
    return typeof value === "string" && UUID_RE.test(value);
}
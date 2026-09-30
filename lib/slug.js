export function slugify(title) {
    const base = title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const suffix = Math.random().toString(36).slice(2, 7);
    return `${base || "project"}-${suffix}`;
}
import sharp from "sharp";
import { BadRequestError } from "./errors.js";

// Formats we're willing to host. SVG is deliberately NOT here: an SVG
// opened directly from a public bucket URL can run script, so it must
// never be served from storage we control. HEIC/HEIF aren't here because
// browsers can't display them.
const ALLOWED = {
    jpeg: { ext: "jpg", type: "image/jpeg" },
    png: { ext: "png", type: "image/png" },
    webp: { ext: "webp", type: "image/webp" },
    gif: { ext: "gif", type: "image/gif" },
    avif: { ext: "avif", type: "image/avif" },
};

/**
 * Looks at the actual bytes (not the filename or the client-supplied
 * Content-Type, both of which are trivially spoofable) and returns the
 * real format, extension and content type to store it under.
 */
export async function inspectImage(buffer) {
    let meta;
    try {
        meta = await sharp(buffer).metadata();
    } catch {
        throw new BadRequestError("That file isn't a valid image.");
    }
    const allowed = ALLOWED[meta.format];
    if (!allowed) {
        throw new BadRequestError("Unsupported image type. Use JPG, PNG, WebP, GIF or AVIF.");
    }
    return { ...allowed, format: meta.format };
}
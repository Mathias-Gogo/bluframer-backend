import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";
import { supabaseAdmin, BUCKETS } from "../lib/supabaseAdmin.js";
import { inspectImage } from "../lib/imageCheck.js";
import { BadRequestError } from "../lib/errors.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function withAvatarUrl(profile) {
    return {
        ...profile,
        avatar_url: profile.avatar_path
            ? supabaseAdmin.storage.from(BUCKETS.avatars).getPublicUrl(profile.avatar_path).data.publicUrl
            : null,
    };
}

router.get("/", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq("id", req.user.id)
        .single();
    if (error) return res.status(404).json({ error: "Profile not found." });
    res.json({ profile: withAvatarUrl(data) });
});

router.patch("/", requireAuth, async (req, res) => {
    const {
        username,
        name,
        title,
        bio,
        skills,
        whatsapp,
        notify_on_request,
        default_restricted,
        onboarded,
        published,
    } = req.body ?? {};

    const patch = {};
    if (username !== undefined) {
        // Validated here too, not just relied on as a DB constraint -- a
        // constraint violation is a raw Postgres error, and the person typing
        // a username deserves a real "3-30 lowercase letters/numbers/hyphens"
        // message, not a 500.
        if (!/^[a-z0-9-]{3,30}$/.test(username)) {
            throw new BadRequestError("Username must be 3-30 characters: lowercase letters, numbers, and hyphens only.");
        }
        patch.username = username;
    }
    if (name !== undefined) patch.name = name;
    if (title !== undefined) patch.title = title;
    if (bio !== undefined) patch.bio = bio;
    if (skills !== undefined) patch.skills = skills;
    if (whatsapp !== undefined) patch.whatsapp = whatsapp;
    if (notify_on_request !== undefined) patch.notify_on_request = notify_on_request;
    if (default_restricted !== undefined) patch.default_restricted = default_restricted;
    if (onboarded !== undefined) patch.onboarded = onboarded;
    if (published !== undefined) patch.published = published;

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update." });

    const { data, error } = await supabaseAdmin
        .from("profiles")
        .update(patch)
        .eq("id", req.user.id)
        .select()
        .single();

    if (error) {
        if (error.code === "23505") return res.status(409).json({ error: "That username is taken." });
        return res.status(500).json({ error: error.message });
    }
    res.json({ profile: withAvatarUrl(data) });
});

router.post("/avatar", requireAuth, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    // Avatars go in a public bucket, so check the real bytes -- not the
    // filename or client-supplied type -- before storing anything.
    const info = await inspectImage(req.file.buffer);
    const path = `${req.user.id}/avatar-${Date.now()}.${info.ext}`;

    const { data: existing } = await supabaseAdmin
        .from("profiles")
        .select("avatar_path")
        .eq("id", req.user.id)
        .single();

    const { error: uploadError } = await supabaseAdmin.storage
        .from(BUCKETS.avatars)
        .upload(path, req.file.buffer, { contentType: info.type, upsert: false });
    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { data, error } = await supabaseAdmin
        .from("profiles")
        .update({ avatar_path: path })
        .eq("id", req.user.id)
        .select()
        .single();
    if (error) {
        await supabaseAdmin.storage.from(BUCKETS.avatars).remove([path]);
        return res.status(500).json({ error: error.message });
    }

    // Replace, don't accumulate: drop the previous avatar file.
    if (existing?.avatar_path) {
        await supabaseAdmin.storage.from(BUCKETS.avatars).remove([existing.avatar_path]);
    }
    res.json({ profile: withAvatarUrl(data) });
});

// Deleting the auth user cascades through every table via "on delete
// cascade" -- but NOT through storage. So collect the file paths first
// (they're unreachable once the rows are gone), delete the account, then
// clear the files. Otherwise a deleted account's original, unwatermarked
// images would stay in the private bucket forever.
router.delete("/", requireAuth, async (req, res) => {
    const uid = req.user.id;

    const { data: profile } = await supabaseAdmin.from("profiles").select("avatar_path").eq("id", uid).single();
    const { data: projects } = await supabaseAdmin.from("projects").select("id").eq("owner_id", uid);
    const { data: posts } = await supabaseAdmin.from("portfolio_posts").select("id").eq("owner_id", uid);
    const projectIds = (projects ?? []).map((p) => p.id);
    const postIds = (posts ?? []).map((p) => p.id);

    const { data: projectImages } = projectIds.length
        ? await supabaseAdmin.from("project_images").select("original_path, preview_path").in("project_id", projectIds)
        : { data: [] };
    const { data: postImages } = postIds.length
        ? await supabaseAdmin.from("portfolio_post_images").select("image_path").in("post_id", postIds)
        : { data: [] };

    const { error } = await supabaseAdmin.auth.admin.deleteUser(uid);
    if (error) return res.status(500).json({ error: error.message });

    const remove = (bucket, paths) =>
        paths.length ? supabaseAdmin.storage.from(bucket).remove(paths) : Promise.resolve();
    await Promise.allSettled([
        remove(BUCKETS.originals, (projectImages ?? []).map((i) => i.original_path)),
        remove(BUCKETS.previews, (projectImages ?? []).map((i) => i.preview_path)),
        remove(BUCKETS.postImages, (postImages ?? []).map((i) => i.image_path)),
        remove(BUCKETS.avatars, profile?.avatar_path ? [profile.avatar_path] : []),
    ]);
    res.status(204).end();
});

export default router;
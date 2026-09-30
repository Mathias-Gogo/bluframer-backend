import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";
import { supabaseAdmin, BUCKETS } from "../lib/supabaseAdmin.js";
import { watermarkImage } from "../lib/watermark.js";
import { inspectImage } from "../lib/imageCheck.js";
import { parseTimerMinutes } from "../lib/validate.js";
import { BadRequestError } from "../lib/errors.js";
import { slugify } from "../lib/slug.js";

const router = Router();

// Uploads are held in memory, so the limits are sized against the smallest
// host we'd realistically deploy to (512MB): worst case per request is
// 10 files x 20MB = 200MB. For more images, send several requests.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

// What the frontend gets. Deliberately no original_path / preview_path:
// storage paths are an implementation detail, and the original's path in
// particular has no business leaving the server.
function shapeProject(project) {
    return {
        id: project.id,
        slug: project.slug,
        title: project.title,
        description: project.description ?? "",
        restricted: project.restricted,
        show_on_portfolio: project.show_on_portfolio,
        view_timer_minutes: project.view_timer_minutes,
        created_at: project.created_at,
        updated_at: project.updated_at,
        images: (project.project_images ?? [])
            .sort((a, b) => a.position - b.position)
            .map((img) => ({
                id: img.id,
                position: img.position,
                is_cover: img.is_cover,
                url: supabaseAdmin.storage.from(BUCKETS.previews).getPublicUrl(img.preview_path).data.publicUrl,
            })),
    };
}

async function removeFiles(bucket, paths) {
    if (paths.length) await supabaseAdmin.storage.from(bucket).remove(paths);
}

// Stores each image twice -- the untouched original in the PRIVATE bucket,
// a watermarked copy in the public one -- one at a time (parallel sharp
// work on big images is what exhausts memory). If anything fails, every
// file already written is removed so nothing is left orphaned.
async function storeImages({ files, checked, project, startPosition, firstIsCover }) {
    const written = { originals: [], previews: [] };
    try {
        const rows = [];
        for (const [i, file] of files.entries()) {
            const position = startPosition + i;
            const base = `${project.owner_id}/${project.id}/${position}-${Date.now()}`;
            const originalPath = `${base}.${checked[i].ext}`;
            const previewPath = `${base}-preview.jpg`;

            const { error: origError } = await supabaseAdmin.storage
                .from(BUCKETS.originals)
                .upload(originalPath, file.buffer, { contentType: checked[i].type, upsert: false });
            if (origError) throw origError;
            written.originals.push(originalPath);

            const watermarked = await watermarkImage(file.buffer);
            const { error: previewError } = await supabaseAdmin.storage
                .from(BUCKETS.previews)
                .upload(previewPath, watermarked, { contentType: "image/jpeg", upsert: false });
            if (previewError) throw previewError;
            written.previews.push(previewPath);

            rows.push({
                project_id: project.id,
                original_path: originalPath,
                preview_path: previewPath,
                position,
                is_cover: firstIsCover && i === 0,
            });
        }

        const { data, error } = await supabaseAdmin.from("project_images").insert(rows).select();
        if (error) throw error;
        return data;
    } catch (err) {
        await removeFiles(BUCKETS.originals, written.originals);
        await removeFiles(BUCKETS.previews, written.previews);
        throw err;
    }
}

router.get("/", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from("projects")
        .select("*, project_images(*)")
        .eq("owner_id", req.user.id)
        .order("updated_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ projects: data.map(shapeProject) });
});

// Registered before "/:id" or Express would read "recent" as an id.
router.get("/recent", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from("recent_opens")
        .select("opened_at, projects(*, project_images(*))")
        .eq("owner_id", req.user.id)
        .order("opened_at", { ascending: false })
        .limit(5);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ recent: data.filter((r) => r.projects).map((r) => shapeProject(r.projects)) });
});

router.get("/:id", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
        .from("projects")
        .select("*, project_images(*)")
        .eq("id", req.params.id)
        .eq("owner_id", req.user.id)
        .single();
    if (error || !data) return res.status(404).json({ error: "Project not found." });
    res.json({ project: shapeProject(data) });
});

// Create the project and upload its images in a single request. Send the
// cover image first -- index 0 becomes the cover.
router.post("/", requireAuth, upload.array("files", 10), async (req, res) => {
    const { title, description = "", restricted, show_on_portfolio, view_timer_minutes } = req.body ?? {};
    if (!title?.trim()) throw new BadRequestError("Title is required.");
    if (!req.files?.length) throw new BadRequestError("At least one file is required.");

    const timer = parseTimerMinutes(view_timer_minutes);
    const isRestricted = restricted !== "false"; // restricted unless explicitly told otherwise
    const showOnPortfolio = show_on_portfolio === "true" && !isRestricted;

    // Validate every file before creating anything.
    const checked = await Promise.all(req.files.map((f) => inspectImage(f.buffer)));

    const { data: project, error: projectError } = await supabaseAdmin
        .from("projects")
        .insert({
            owner_id: req.user.id,
            slug: slugify(title),
            title: title.trim(),
            description: description.trim(),
            restricted: isRestricted,
            show_on_portfolio: showOnPortfolio,
            view_timer_minutes: timer,
        })
        .select()
        .single();
    if (projectError) return res.status(500).json({ error: projectError.message });

    try {
        const images = await storeImages({
            files: req.files,
            checked,
            project,
            startPosition: 0,
            firstIsCover: true,
        });
        res.status(201).json({ project: shapeProject({ ...project, project_images: images }) });
    } catch (err) {
        // No project without images, and no images without a project.
        await supabaseAdmin.from("projects").delete().eq("id", project.id);
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

router.post("/:id/images", requireAuth, upload.array("files", 10), async (req, res) => {
    const { data: project } = await supabaseAdmin
        .from("projects")
        .select("*, project_images(position)")
        .eq("id", req.params.id)
        .eq("owner_id", req.user.id)
        .single();
    if (!project) return res.status(404).json({ error: "Project not found." });
    if (!req.files?.length) throw new BadRequestError("At least one file is required.");

    const checked = await Promise.all(req.files.map((f) => inspectImage(f.buffer)));

    // Next position after the highest existing one -- NOT the count, which
    // collides with an existing image once any earlier one has been deleted.
    const existing = project.project_images ?? [];
    const startPosition = existing.length ? Math.max(...existing.map((i) => i.position)) + 1 : 0;

    try {
        const images = await storeImages({
            files: req.files,
            checked,
            project,
            startPosition,
            firstIsCover: existing.length === 0,
        });
        await supabaseAdmin.from("projects").update({ updated_at: new Date().toISOString() }).eq("id", project.id);
        res.status(201).json({ images: shapeProject({ ...project, project_images: images }).images });
    } catch (err) {
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

router.delete("/:id/images/:imageId", requireAuth, async (req, res) => {
    const { data: image } = await supabaseAdmin
        .from("project_images")
        .select("*, projects!inner(owner_id)")
        .eq("id", req.params.imageId)
        .eq("project_id", req.params.id)
        .single();
    // 404 (not 403) for someone else's project, so ids can't be probed.
    if (!image || image.projects.owner_id !== req.user.id) {
        return res.status(404).json({ error: "Image not found." });
    }

    const { error } = await supabaseAdmin.from("project_images").delete().eq("id", image.id);
    if (error) return res.status(500).json({ error: error.message });
    await removeFiles(BUCKETS.originals, [image.original_path]);
    await removeFiles(BUCKETS.previews, [image.preview_path]);

    // If the cover was removed, the first remaining image takes over.
    if (image.is_cover) {
        const { data: rest } = await supabaseAdmin
            .from("project_images")
            .select("id, position")
            .eq("project_id", req.params.id);
        const next = (rest ?? []).sort((a, b) => a.position - b.position)[0];
        if (next) await supabaseAdmin.from("project_images").update({ is_cover: true }).eq("id", next.id);
    }
    res.status(204).end();
});

router.patch("/:id", requireAuth, async (req, res) => {
    const { title, description, restricted, show_on_portfolio, view_timer_minutes } = req.body ?? {};
    const patch = { updated_at: new Date().toISOString() };

    if (title !== undefined) {
        if (!String(title).trim()) throw new BadRequestError("Title can't be empty.");
        patch.title = String(title).trim();
    }
    if (description !== undefined) patch.description = String(description).trim();
    if (restricted !== undefined) patch.restricted = restricted;
    if (show_on_portfolio !== undefined) patch.show_on_portfolio = show_on_portfolio;
    if (view_timer_minutes !== undefined) patch.view_timer_minutes = parseTimerMinutes(view_timer_minutes);

    // Locking a project down also takes it off the portfolio.
    if (patch.restricted === true) patch.show_on_portfolio = false;

    const { data, error } = await supabaseAdmin
        .from("projects")
        .update(patch)
        .eq("id", req.params.id)
        .eq("owner_id", req.user.id)
        .select("*, project_images(*)")
        .single();

    if (error) {
        // The DB constraint: restricted projects can't be on the portfolio.
        if (error.code === "23514") {
            throw new BadRequestError("Only Open projects can be shown on your portfolio.");
        }
        if (error.code === "PGRST116") return res.status(404).json({ error: "Project not found." });
        return res.status(500).json({ error: error.message });
    }
    res.json({ project: shapeProject(data) });
});

router.delete("/:id", requireAuth, async (req, res) => {
    const { data: project } = await supabaseAdmin
        .from("projects")
        .select("id, project_images(original_path, preview_path)")
        .eq("id", req.params.id)
        .eq("owner_id", req.user.id)
        .single();
    if (!project) return res.status(404).json({ error: "Project not found." });

    const { error } = await supabaseAdmin.from("projects").delete().eq("id", project.id);
    if (error) return res.status(500).json({ error: error.message });

    // The row cascade doesn't reach storage. Without this, a deleted
    // project's original files would stay in the bucket indefinitely.
    await removeFiles(BUCKETS.originals, project.project_images.map((i) => i.original_path));
    await removeFiles(BUCKETS.previews, project.project_images.map((i) => i.preview_path));
    res.status(204).end();
});

// Backs the sidebar's Recent list.
router.post("/:id/opened", requireAuth, async (req, res) => {
    // Must own the project -- otherwise anyone could add someone else's
    // project to their own Recent list and read it back from /recent.
    const { data: project } = await supabaseAdmin
        .from("projects")
        .select("id")
        .eq("id", req.params.id)
        .eq("owner_id", req.user.id)
        .single();
    if (!project) return res.status(404).json({ error: "Project not found." });

    const { error } = await supabaseAdmin
        .from("recent_opens")
        .upsert(
            { owner_id: req.user.id, project_id: project.id, opened_at: new Date().toISOString() },
            { onConflict: "owner_id,project_id" }
        );
    if (error) return res.status(500).json({ error: error.message });
    res.status(204).end();
});

export default router;
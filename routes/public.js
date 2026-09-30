import { Router } from "express";
import { supabaseAdmin, BUCKETS } from "../lib/supabaseAdmin.js";
import { checkViewTimer } from "../lib/viewTimer.js";
import { BadRequestError } from "../lib/errors.js";

const router = Router();
const DOWNLOAD_URL_TTL = 600; // 10 minutes -- long enough to click Download, short-lived by design
const BROWSE_URL_TTL = 3600; // portfolio-grid signed URLs, generated fresh on every page load anyway

function publicUrl(bucket, path) {
    return supabaseAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

async function signedUrl(bucket, path, expiresIn) {
    const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (error) throw error;
    return data.signedUrl;
}

function shapePost(post) {
    return {
        kind: "post",
        id: post.id,
        title: post.title ?? "",
        description: post.description ?? "",
        images: (post.portfolio_post_images ?? [])
            .sort((a, b) => a.position - b.position)
            .map((img) => ({ id: img.id, url: publicUrl(BUCKETS.postImages, img.image_path) })),
    };
}

// Eligible here always means show_on_portfolio + not restricted -- enforced
// by the DB constraint, but the extra .eq("restricted", false) below means
// a bug elsewhere can't accidentally leak a restricted project's images
// onto the public portfolio grid.
async function shapePortfolioProject(project) {
    const images = await Promise.all(
        (project.project_images ?? [])
            .sort((a, b) => a.position - b.position)
            .map(async (img) => ({ id: img.id, url: await signedUrl(BUCKETS.originals, img.original_path, BROWSE_URL_TTL) }))
    );
    return { kind: "project", id: project.id, slug: project.slug, title: project.title, images };
}

// GET /api/public/:username -- profile + standalone posts + any Open
// projects the creative chose to show. Two lists, not merged -- a project
// tile should link to the real project page, a post tile should open the
// simple album view, and those aren't the same click behavior.
router.get("/:username", async (req, res) => {
    const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("id, username, name, title, bio, skills, whatsapp, avatar_path, published")
        .eq("username", req.params.username)
        .single();
    if (profileError || !profile) return res.status(404).json({ error: "Creative not found." });

    const [{ data: posts }, { data: projects }] = await Promise.all([
        supabaseAdmin
            .from("portfolio_posts")
            .select("*, portfolio_post_images(*)")
            .eq("owner_id", profile.id)
            .order("created_at", { ascending: false }),
        supabaseAdmin
            .from("projects")
            .select("*, project_images(*)")
            .eq("owner_id", profile.id)
            .eq("status", "published")
            .eq("show_on_portfolio", true)
            .eq("restricted", false),
    ]);

    res.json({
        profile: {
            username: profile.username,
            name: profile.name,
            title: profile.title ?? "",
            bio: profile.bio ?? "",
            skills: profile.skills ?? [],
            whatsapp: profile.whatsapp ?? null,
            published: profile.published,
            avatar_url: profile.avatar_path ? publicUrl(BUCKETS.avatars, profile.avatar_path) : null,
        },
        posts: (posts ?? []).map(shapePost),
        projects: await Promise.all((projects ?? []).map(shapePortfolioProject)),
    });
});

// GET /api/public/:username/:slug?visitor_id=... -- a single project. This
// is where locked-vs-open and the timer are actually decided; nothing
// upstream of this function can be trusted to have enforced either.
router.get("/:username/:slug", async (req, res) => {
    const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("id, username, name")
        .eq("username", req.params.username)
        .single();
    if (!profile) return res.status(404).json({ error: "Project not found." });

    const { data: project } = await supabaseAdmin
        .from("projects")
        .select("*, project_images(*)")
        .eq("owner_id", profile.id)
        .eq("slug", req.params.slug)
        .eq("status", "published")
        .single();
    if (!project) return res.status(404).json({ error: "Project not found." });

    const { remainingSeconds, expired } = await checkViewTimer(
        project.id,
        req.query.visitor_id,
        project.view_timer_minutes
    );

    const images = expired
        ? []
        : await Promise.all(
            [...project.project_images]
                .sort((a, b) => a.position - b.position)
                .map(async (img) => ({
                    id: img.id,
                    // Restricted NEVER returns a URL to the original -- not
                    // watermarked-and-downloadable, not signed-but-hidden. There is
                    // simply no path from this response to the real file. Open
                    // returns a short-lived signed URL to it.
                    url: project.restricted
                        ? publicUrl(BUCKETS.previews, img.preview_path)
                        : await signedUrl(BUCKETS.originals, img.original_path, DOWNLOAD_URL_TTL),
                }))
        );

    res.json({
        creative: { username: profile.username, name: profile.name },
        project: {
            id: project.id,
            title: project.title,
            description: project.description ?? "",
            restricted: project.restricted,
            view_timer_minutes: project.view_timer_minutes,
        },
        time_remaining_seconds: remainingSeconds,
        expired,
        images,
    });
});

export default router;
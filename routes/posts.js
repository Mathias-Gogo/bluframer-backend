import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";
import { supabaseAdmin, BUCKETS } from "../lib/supabaseAdmin.js";
import { inspectImage } from "../lib/imageCheck.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 }, // 10MB x 20 = 200MB worst case in memory
});

// Portfolio posts are standalone showcase work -- no client, no
// restrict/unlock, no watermark. They live in a public bucket and are
// always freely viewable, which is exactly why every upload is checked to
// be a real image before it goes in.

function publicUrl(path) {
  return supabaseAdmin.storage.from(BUCKETS.postImages).getPublicUrl(path).data.publicUrl;
}

// Shape matches what the frontend already uses: { id, title, description, images: [{ id, url }] }
function shapePost(post) {
  return {
    id: post.id,
    title: post.title ?? "",
    description: post.description ?? "",
    created_at: post.created_at,
    images: (post.portfolio_post_images ?? [])
      .sort((a, b) => a.position - b.position)
      .map((img) => ({ id: img.id, url: publicUrl(img.image_path), position: img.position })),
  };
}

router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("portfolio_posts")
    .select("*, portfolio_post_images(*)")
    .eq("owner_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ posts: data.map(shapePost) });
});

// Create a post + upload all of its images in one request.
router.post("/", requireAuth, upload.array("files", 20), async (req, res) => {
  const { title = "", description = "" } = req.body ?? {};
  if (!req.files?.length) return res.status(400).json({ error: "Add at least one image." });

  // Validate every file before creating or uploading anything, so a bad
  // file in the middle of a batch doesn't leave a half-built post behind.
  const checked = await Promise.all(req.files.map((f) => inspectImage(f.buffer)));

  const { data: post, error: postError } = await supabaseAdmin
    .from("portfolio_posts")
    .insert({ owner_id: req.user.id, title: title.trim(), description: description.trim() })
    .select()
    .single();
  if (postError) return res.status(500).json({ error: postError.message });

  const uploadedPaths = [];
  try {
    const rows = [];
    for (const [index, file] of req.files.entries()) {
      const path = `${req.user.id}/${post.id}/${index}-${Date.now()}.${checked[index].ext}`;
      const { error } = await supabaseAdmin.storage
        .from(BUCKETS.postImages)
        .upload(path, file.buffer, { contentType: checked[index].type, upsert: false });
      if (error) throw error;
      uploadedPaths.push(path);
      rows.push({ post_id: post.id, image_path: path, position: index });
    }
    const { data: images, error: insertError } = await supabaseAdmin
      .from("portfolio_post_images")
      .insert(rows)
      .select();
    if (insertError) throw insertError;

    res.status(201).json({ post: shapePost({ ...post, portfolio_post_images: images }) });
  } catch (err) {
    // Undo everything: the post row (its image rows cascade) and any files
    // that already made it into storage.
    await supabaseAdmin.from("portfolio_posts").delete().eq("id", post.id);
    if (uploadedPaths.length) await supabaseAdmin.storage.from(BUCKETS.postImages).remove(uploadedPaths);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  const { title, description } = req.body ?? {};
  const patch = {};
  if (title !== undefined) patch.title = String(title).trim();
  if (description !== undefined) patch.description = String(description).trim();
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to update." });

  const { data, error } = await supabaseAdmin
    .from("portfolio_posts")
    .update(patch)
    .eq("id", req.params.id)
    .eq("owner_id", req.user.id)
    .select("*, portfolio_post_images(*)")
    .single();
  if (error || !data) return res.status(404).json({ error: "Post not found." });
  res.json({ post: shapePost(data) });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const { data: post, error: fetchError } = await supabaseAdmin
    .from("portfolio_posts")
    .select("id, portfolio_post_images(image_path)")
    .eq("id", req.params.id)
    .eq("owner_id", req.user.id)
    .single();
  if (fetchError || !post) return res.status(404).json({ error: "Post not found." });

  const paths = post.portfolio_post_images.map((img) => img.image_path);
  const { error } = await supabaseAdmin.from("portfolio_posts").delete().eq("id", post.id);
  if (error) return res.status(500).json({ error: error.message });

  // Row is gone -- now clear the files so storage doesn't accumulate orphans.
  if (paths.length) await supabaseAdmin.storage.from(BUCKETS.postImages).remove(paths);
  res.status(204).end();
});

export default router;
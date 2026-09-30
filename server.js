import "dotenv/config";
import express from "express";
import cors from "cors";
import profileRouter from "./routes/profile.js";
import projectsRouter from "./routes/projects.js";
import postsRouter from "./routes/posts.js";
import publicRouter from "./routes/public.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN?.split(",") ?? "*",
  })
);
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/profile", profileRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/posts", postsRouter);
app.use("/api/public", publicRouter);

// Routes get mounted here as each step lands:

app.use(errorHandler);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Bluframer backend listening on :${port}`));
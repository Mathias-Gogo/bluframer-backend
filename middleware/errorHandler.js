import multer from "multer";

// Turns upload/validation problems into proper 4xx responses instead of a
// generic 500, and logs anything genuinely unexpected.
export function errorHandler(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        const messages = {
            LIMIT_FILE_SIZE: "That file is too large.",
            LIMIT_FILE_COUNT: "Too many files.",
            LIMIT_UNEXPECTED_FILE: "Too many files.",
        };
        return res.status(400).json({ error: messages[err.code] ?? err.message });
    }

    if (err.status && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
    }

    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
}
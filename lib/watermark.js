import sharp from "sharp";

// Tiled, semi-transparent watermark baked directly into the pixels -- not
// a CSS overlay, so it survives a screenshot. The client sees full
// resolution and real detail; what they can't get is a clean file.
function watermarkSvg(width, height, label = "BLUFRAMER \u00B7 PREVIEW") {
    // Scale everything off image width so the watermark stays proportionally
    // consistent whether it's a 800px preview or a 4000px camera export --
    // a fixed pixel size would be nearly invisible on large images and easy
    // to crop or clean out.
    const fontSize = Math.max(16, Math.round(width / 28));
    const tileW = fontSize * 11;
    const tileH = fontSize * 7;
    const cols = Math.ceil(width / tileW) + 1;
    const rows = Math.ceil(height / tileH) + 1;

    let tiles = "";
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = c * tileW - (r % 2 === 0 ? 0 : tileW / 2);
            const y = r * tileH;
            tiles += `<text x="${x}" y="${y}" transform="rotate(-22 ${x} ${y})"
        font-family="sans-serif" font-size="${fontSize}" font-weight="600"
        fill="rgba(255,255,255,0.35)" stroke="rgba(0,0,0,0.25)" stroke-width="${Math.max(0.5, fontSize / 40)}">${label}</text>`;
        }
    }

    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${tiles}</svg>`
    );
}

/**
 * Takes an original image buffer, returns a full-resolution buffer with a
 * tiled watermark composited on top. Used for the "preview" copy served
 * whenever a project is restricted.
 */
export async function watermarkImage(inputBuffer) {
    // Phone/camera photos store rotation as EXIF metadata rather than in the
    // pixels. sharp drops that metadata on output, so without .rotate() a
    // portrait photo would come out of here lying on its side. Orientations
    // 5-8 also swap width and height, which the watermark size depends on.
    const { width, height, orientation } = await sharp(inputBuffer).metadata();
    const swapped = orientation && orientation >= 5;
    const outW = swapped ? height : width;
    const outH = swapped ? width : height;

    return sharp(inputBuffer)
        .rotate()
        .composite([{ input: watermarkSvg(outW, outH), top: 0, left: 0 }])
        .jpeg({ quality: 90 })
        .toBuffer();
}
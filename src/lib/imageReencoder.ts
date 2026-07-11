/* ----------------------------------------------------------------------------
 * imageReencoder
 * --------------------------------------------------------------------------
 * Small Canvas-API round-trip that returns a WEBP blob when the input is a
 * JPEG/PNG (or non-animated WEBP source we choose to recompress), and
 * silently falls back to the ORIGINAL bytes for every case we don't
 * explicitly support. Reasons:
 *
 *   1. SVG sources are vector. Round-tripping through a canvas rasterises
 *      them and loses vector nature, which is a regression. Skip.
 *
 *   2. Animated GIFs become static frames; the user loses the animation.
 *      Skip (cannot be detected cheaply from this side; require
 *      explicit `image/gif` MIME header from the browser).
 *
 *   3. Canvas size limits vary across browsers and devices. IPhones cap at
 *      ~16M pixels; Safari is around 16,777,216 in either dimension. We
 *      use the IMAGEBitmap metadata to check BEFORE attempting to draw,
 *      because a failed draw usually destroys the canvas state.
 *
 *   4. The encoded blob is sometimes larger than the original (especially
 *      for tiny icons). When that happens we keep the original bytes so
 *      the export isn't accidentally heavier.
 *
 * The exported function returns `{ blob, mime, reencoded }`:
 *   - `blob`      — the bytes to write to the zip (may be the ORIGINAL).
 *   - `mime`      — the MIME type the asset should be labelled with
 *                    (important for the zip entry to be correctly
 *                    interpreted by the friendly folder).
 *   - `reencoded` — true iff we actually round-tripped through a canvas
 *                    and the new file is the one that landed.
 * -------------------------------------------------------------------------*/

interface ReencodeResult {
  blob: Blob;
  mime: string;
  /** True iff we re-encoded the bytes through WebP. False means the
   *  caller will receive the original bytes back unchanged. */
  reencoded: boolean;
  /** Diagnostic reason when the encoder fell back to the original.
   *  Surfaced in the History pill if the user opted in but encoding
   *  fell through (so the audit log still shows "user expected WebP,
   *  engine couldn't do it"). */
  fallbackReason?: string;
}

/** Maximum side length in pixels we attempt to draw. Most browsers and
 *  devices support 8192²; the canvas backing-store limit is usually
 *  somewhere between 16M and 64M pixels. We use the conservative
 *  8192 on either side so common laptops AND iPhones succeed. */
const MAX_SIDE = 8192;
/** Maximum pixel budget for the reencode. 32M pixels (= 8192×4096) is
 *  safely below every browser's documented limit. */
const MAX_PIXELS = 32 * 1024 * 1024;

/** Quality parameter handed to `canvas.toBlob`. Conservative — WebP at
 *  0.85 is roughly visually lossless for most photograph content. */
const WEBP_QUALITY = 0.85;

/**
 * Re-encode the input file bytes as WebP when the conditions above allow.
 * Otherwise returns the original blob unchanged with `reencoded: false`
 * and a `fallbackReason` for the caller to surface in the UI.
 */
export async function reencodeToWebP(file: File): Promise<ReencodeResult> {
  const originalBlob = file;

  // SOURCE-MIME GATE
  // We only encode JPEG / PNG sources. SVG is intentionally excluded
  // because the round-trip would convert vector to bitmap and lose
  // crispness. WebP itself is excluded because createImageBitmap only
  // gives us the FIRST frame, but the file may be animated. The user
  // gets the original back and the audit log shows why.
  const supported = /^image\/(png|jpeg)$/i.test(file.type);
  if (!supported) {
    return {
      blob: originalBlob,
      mime: file.type || 'image/png',
      reencoded: false,
      fallbackReason: file.type === 'image/gif'
        ? 'animated GIF (skipped to preserve animation)'
        : file.type === 'image/svg+xml'
          ? 'SVG (kept as vector)'
          : file.type === 'image/webp'
            ? 'WebP (preserved to avoid animation risk)'
            : `unsupported source type "${file.type || 'unknown'}"`,
    };
  }

  // DECODE + DIMENSION CHECK
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    return {
      blob: originalBlob,
      mime: file.type,
      reencoded: false,
      fallbackReason: `decode failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  // Cleanup the bitmap in a finally-equivalent via try/finally pattern
  // below to avoid leaking GPU memory even on error paths.
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (width === 0 || height === 0) {
      return {
        blob: originalBlob,
        mime: file.type,
        reencoded: false,
        fallbackReason: 'zero-sized image',
      };
    }
    if (width > MAX_SIDE || height > MAX_SIDE) {
      return {
        blob: originalBlob,
        mime: file.type,
        reencoded: false,
        fallbackReason: `dimensions ${width}×${height} exceed ${MAX_SIDE}px cap`,
      };
    }
    if (width * height > MAX_PIXELS) {
      return {
        blob: originalBlob,
        mime: file.type,
        reencoded: false,
        fallbackReason: `pixel count ${width * height} exceeds ${MAX_PIXELS} budget`,
      };
    }

    // RASTERISE
    // Draw the bitmap to a fresh canvas sized to the exact image
    // dimensions. We don't upscale — encoding preserves authored size.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        blob: originalBlob,
        mime: file.type,
        reencoded: false,
        fallbackReason: 'canvas 2D context unavailable',
      };
    }
    ctx.drawImage(bitmap, 0, 0);

    // ENCODE
    const webpBlob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
    if (!webpBlob) {
      return {
        blob: originalBlob,
        mime: file.type,
        reencoded: false,
        fallbackReason: 'canvas.toBlob produced null',
      };
    }

    // SHRINKAGE GATE
    // Don't ship a bigger file than the original. Sometimes a 16×16 PNG
    // repaints through canvas into a 4KB WebP that is bigger — always
    // pick the smaller one.
    if (webpBlob.size >= originalBlob.size) {
      return {
        blob: originalBlob,
        mime: file.type,
        reencoded: false,
        fallbackReason: `WebP was larger (${webpBlob.size} >= ${originalBlob.size})`,
      };
    }

    return {
      blob: webpBlob,
      mime: 'image/webp',
      reencoded: true,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Promise-wrapped canvas.toBlob. The browser API uses callbacks; we wrap
 * it so the call sites can `await` and use try/catch with the rest of
 * the reencode pipeline.
 */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), mime, quality);
  });
}

/**
 * Compute the .webp extension equivalent when re-encoding was successful,
 * so the saved asset filename matches the bytes the user is about to see.
 * `logo.png` → `logo.webp`, `hero.jpeg` → `hero.webp`, etc.
 */
export function rewriteExtensionToWebp(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return `${filename}.webp`;
  return `${filename.slice(0, lastDot)}.webp`;
}

/**
 * PNG self-diff: compares two screenshots of the same page and viewport and
 * reports how many pixels differ and where.
 *
 * The comparison is strict: {@link diffPngs} runs `pixelmatch` with a zero
 * threshold and anti-aliased pixels included, so any changed pixel counts.
 * The differing pixels are summarised as one bounding box enclosing every
 * one of them, the region a flaky capture record carries. Two images of
 * different sizes are not compared pixel by pixel: the whole larger box,
 * the widest width by the tallest height, counts as differing.
 *
 * The module works on PNG buffers, read through `pngjs`, so it needs no
 * browser.
 *
 * @packageDocumentation
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** A rectangle in image pixels, its origin at the top-left corner. */
export interface DiffRegion {
  /** Left edge, in pixels from the image's left. */
  readonly x: number;
  /** Top edge, in pixels from the image's top. */
  readonly y: number;
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
}

/** What {@link diffPngs} found between two images. */
export interface DiffResult {
  /** How many pixels differ; the larger box's area on a size mismatch. */
  readonly differingPixels: number;
  /** The box enclosing every differing pixel, or `null` when none differ. */
  readonly region: DiffRegion | null;
}

/** Zero tolerance: any colour change in a pixel counts as a difference. */
const STRICT_THRESHOLD = 0;

/** Bytes per RGBA pixel in a decoded PNG. */
const BYTES_PER_PIXEL = 4;

/** Offset of the alpha byte within an RGBA pixel. */
const ALPHA_OFFSET = 3;

/**
 * Compares two PNG images and reports the differing-pixel count and the one
 * box enclosing every differing pixel.
 *
 * @param first - The first capture, as PNG bytes.
 * @param second - The second capture, as PNG bytes.
 * @returns The count and region; `region` is `null` when the images match.
 * @throws When either buffer is not a readable PNG.
 */
export function diffPngs(first: Buffer, second: Buffer): DiffResult {
  const left = PNG.sync.read(first);
  const right = PNG.sync.read(second);
  if (left.width !== right.width || left.height !== right.height) {
    return sizeMismatch(left, right);
  }
  const { width, height } = left;
  const mask = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  const differingPixels = pixelmatch(left.data, right.data, mask, width, height, {
    threshold: STRICT_THRESHOLD,
    includeAA: true,
    diffMask: true,
  });
  return {
    differingPixels,
    region: differingPixels === 0
      ? null
      : maskBounds(mask, width, height),
  };
}

/** The whole larger box, reported when the two images differ in size. */
function sizeMismatch(left: PNG, right: PNG): DiffResult {
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  return {
    differingPixels: width * height,
    region: { x: 0, y: 0, width, height },
  };
}

/**
 * The box enclosing every pixel `pixelmatch` marked in a diff mask; with
 * `diffMask` set, only differing pixels are drawn, opaque, over a
 * transparent background.
 */
function maskBounds(mask: Buffer, width: number, height: number): DiffRegion | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[(y * width + x) * BYTES_PER_PIXEL + ALPHA_OFFSET] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

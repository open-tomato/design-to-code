import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';

import { diffPngs } from './diff.ts';

/** An RGBA colour. */
type Rgba = readonly [number, number, number, number];

const WHITE: Rgba = [255, 255, 255, 255];

const BLACK: Rgba = [0, 0, 0, 255];

/** A pixel to paint over the solid background. */
interface Paint {
  readonly x: number;
  readonly y: number;
  readonly colour: Rgba;
}

/** Encodes a `width` by `height` white PNG with `paints` drawn over it. */
function makePng(width: number, height: number, paints: readonly Paint[] = []): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    png.data.set(WHITE, index * 4);
  }
  for (const { x, y, colour } of paints) {
    png.data.set(colour, (y * width + x) * 4);
  }
  return PNG.sync.write(png);
}

/** Black paints filling the rectangle at `x`, `y` of `width` by `height`. */
function block(x: number, y: number, width: number, height: number): Paint[] {
  const paints: Paint[] = [];
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      paints.push({ x: column, y: row, colour: BLACK });
    }
  }
  return paints;
}

describe('diffPngs', () => {
  test('reports no differing pixels and no region for identical images', () => {
    const image = makePng(40, 30, block(5, 5, 3, 3));

    const result = diffPngs(image, makePng(40, 30, block(5, 5, 3, 3)));

    expect(result).toEqual({ differingPixels: 0, region: null });
  });

  test('reports one pixel and a one-pixel box for one changed pixel', () => {
    const before = makePng(40, 30);
    const after = makePng(40, 30, [{ x: 17, y: 9, colour: [254, 255, 255, 255] }]);

    const result = diffPngs(before, after);

    expect(result).toEqual({
      differingPixels: 1,
      region: { x: 17, y: 9, width: 1, height: 1 },
    });
  });

  test('encloses two distant changed regions in one box', () => {
    const before = makePng(100, 80);
    const after = makePng(100, 80, [...block(2, 3, 4, 2), ...block(90, 70, 5, 6)]);

    const result = diffPngs(before, after);

    expect(result).toEqual({
      differingPixels: 4 * 2 + 5 * 6,
      region: { x: 2, y: 3, width: 93, height: 73 },
    });
  });

  test('reports a height mismatch over the whole larger box', () => {
    const short = makePng(40, 30);
    const tall = makePng(40, 55);

    const result = diffPngs(short, tall);

    expect(result).toEqual({
      differingPixels: 40 * 55,
      region: { x: 0, y: 0, width: 40, height: 55 },
    });
    expect(diffPngs(tall, short)).toEqual(result);
  });

  test('throws on a buffer that is not a PNG', () => {
    expect(() => diffPngs(Buffer.from('not a png'), makePng(2, 2))).toThrow();
  });
});

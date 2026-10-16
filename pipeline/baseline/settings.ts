/**
 * Shared capture settings: the one set of browser conditions every baseline
 * capture runs under, exported so the later design-vs-code and state-replay
 * gates capture under exactly the same conditions.
 *
 * Each capture gets a fresh Chromium context built from
 * {@link contextOptions} (the config viewport, `deviceScaleFactor: 1`,
 * `locale: 'en-US'`, `timezoneId: 'UTC'`), installs the page clock at
 * {@link FIXED_EPOCH} before navigation, and adds {@link seededRandomScript}
 * as an init script so `Math.random` yields the same sequence on every load.
 * Motion is not disabled: screenshots use {@link SCREENSHOT_ANIMATIONS}.
 *
 * @packageDocumentation
 */

/** The instant the page clock is installed at, 2024-01-01T00:00:00Z. */
export const FIXED_EPOCH = Date.UTC(2024, 0, 1);

/** The seed the replacement `Math.random` starts from. */
export const RANDOM_SEED = 0x2f6b_3a1d;

/** The device pixel ratio every capture renders at. */
export const DEVICE_SCALE_FACTOR = 1;

/** The locale every capture context reports. */
export const LOCALE = 'en-US';

/** The time zone every capture context runs in. */
export const TIMEZONE_ID = 'UTC';

/** Screenshots leave animations running rather than freezing them. */
export const SCREENSHOT_ANIMATIONS = 'allow';

/** A named viewport size, as the config's `viewports` entries. */
export interface CaptureViewport {
  /** The viewport's name, used as its PNG file name. */
  readonly name: string;
  /** Width in CSS pixels. */
  readonly width: number;
  /** Height in CSS pixels. */
  readonly height: number;
}

/** The Chromium context options one capture runs under. */
export interface CaptureContextOptions {
  /** The viewport size. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Always {@link DEVICE_SCALE_FACTOR}. */
  readonly deviceScaleFactor: number;
  /** Always {@link LOCALE}. */
  readonly locale: string;
  /** Always {@link TIMEZONE_ID}. */
  readonly timezoneId: string;
}

/**
 * Builds the context options for one viewport.
 *
 * @param viewport - The config viewport to capture at.
 * @returns Options ready for `browser.newContext`.
 */
export function contextOptions(viewport: CaptureViewport): CaptureContextOptions {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: LOCALE,
    timezoneId: TIMEZONE_ID,
  };
}

/**
 * Builds the init-script source that replaces `Math.random` with a
 * mulberry32 PRNG started from `seed`.
 *
 * @param seed - The 32-bit seed; defaults to {@link RANDOM_SEED}.
 * @returns JavaScript source for `context.addInitScript`.
 */
export function seededRandomScript(seed: number = RANDOM_SEED): string {
  return `(() => {
  let state = ${seed >>> 0};
  Math.random = function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;
}

/** The init script for {@link RANDOM_SEED}, shared by every capture. */
export const SEEDED_RANDOM_SCRIPT = seededRandomScript();

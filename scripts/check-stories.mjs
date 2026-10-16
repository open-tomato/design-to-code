#!/usr/bin/env node
/**
 * Story doctor — loads every story of a built Storybook in headless Chromium
 * and fails if any story logs a console error, throws a page error, or shows
 * the Storybook error overlay. This is the "does the preview actually work
 * for users" gate that headless vitest smoke tests cannot see (they run
 * stories through a different pipeline).
 *
 * Usage:
 *   bun run build:storybook
 *   node scripts/check-stories.mjs [staticDir=storybook-static] [port=6007]
 *
 * Imported, it exports {@link checkStories}, which returns each story id with
 * its errors instead of printing them and exiting.
 *
 * The build is served on the loopback interface only, and every request path
 * passes {@link resolveStaticPath} before any file is read.
 *
 * @packageDocumentation
 */
import { existsSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

/** The directory checked when the command line names none. */
export const DEFAULT_STATIC_DIR = 'storybook-static';

/** The port served on when the command line names none. */
export const DEFAULT_PORT = 6007;

/** The only interface the story server listens on. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Read error codes that mean the request names no file, answered with 404. */
const NOT_FOUND_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR']);

/** The error recorded for a story whose Storybook error overlay is visible. */
export const OVERLAY_ERROR = 'storybook error overlay is visible';

/** How long, in ms, a story is left to settle after the network goes idle. */
const SETTLE_MS = 300;

/** The longest error message kept, in characters. */
const MAX_ERROR_LENGTH = 200;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * The first line of `text`, cut to {@link MAX_ERROR_LENGTH} characters.
 *
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return (text.split('\n')[0] ?? '').slice(0, MAX_ERROR_LENGTH);
}

/**
 * Whether `candidate` is `root` itself or a path below it.
 *
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isInside(root, candidate) {
  const fromRoot = relative(root, candidate);

  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

/**
 * Maps the raw request target `rawTarget` (`req.url`) to a file under
 * `staticDir`, or to a refusal: 400 for a malformed percent escape or a NUL
 * byte, 403 for a path that resolves outside `staticDir` (`/..%2fx`) or an
 * existing file whose real path lies outside it. `/` maps to `index.html`.
 * The target is read raw, so no URL parser drops dot segments first.
 *
 * @param {string} staticDir
 * @param {string} rawTarget
 * @returns {{ file: string } | { status: 400 | 403, reason: string }}
 */
export function resolveStaticPath(staticDir, rawTarget) {
  const rawPath = rawTarget.split(/[?#]/, 1)[0] ?? '';
  let path;

  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { status: 400, reason: `malformed percent-encoding in ${rawPath}` };
  }

  if (path.includes('\0')) return { status: 400, reason: `NUL byte in ${rawPath}` };

  const root = resolve(staticDir);
  const file = resolve(root, `.${path === '/'
    ? '/index.html'
    : path}`);

  if (!isInside(root, file)) return { status: 403, reason: `${rawPath} resolves outside the served dir` };

  if (existsSync(file) && !isInside(realpathSync(root), realpathSync(file))) {
    return { status: 403, reason: `${rawPath} links outside the served dir` };
  }

  return { file };
}

/**
 * Starts a static file server over `staticDir` on `port` of
 * {@link LOOPBACK_HOST} (0 picks a free port). A refused path answers its
 * 400 or 403, a missing file 404, and any other read error 500, logged to
 * stderr.
 *
 * @param {string} staticDir
 * @param {number} port
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>}
 */
export async function serveStaticDir(staticDir, port) {
  const server = createServer(async (req, res) => {
    /** @type {ReturnType<typeof resolveStaticPath>} */
    let target;

    try {
      target = resolveStaticPath(staticDir, req.url ?? '/');
    } catch (error) {
      console.error(`check-stories: cannot resolve ${req.url ?? '/'}: ${String(error)}`);
      res.writeHead(500);
      res.end('read error');

      return;
    }

    if ('status' in target) {
      res.writeHead(target.status);
      res.end(target.reason);

      return;
    }

    try {
      const body = await readFile(target.file);

      res.writeHead(200, { 'content-type': MIME[/** @type {keyof typeof MIME} */ (extname(target.file))] ?? 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      if (NOT_FOUND_CODES.has(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) {
        res.writeHead(404);
        res.end('not found');

        return;
      }

      console.error(`check-stories: cannot read ${target.file}: ${String(error)}`);
      res.writeHead(500);
      res.end('read error');
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, LOOPBACK_HOST, () => ok(undefined));
  });

  const address = server.address();
  const bound = typeof address === 'object' && address !== null
    ? address
    : undefined;

  return {
    host: bound?.address ?? LOOPBACK_HOST,
    port: bound?.port ?? port,
    close: () => new Promise((ok) => server.close(() => ok(undefined))),
  };
}

/**
 * The id of every story entry in the build's `index.json`.
 *
 * @param {string} staticDir
 * @returns {Promise<string[]>}
 */
async function readStoryIds(staticDir) {
  const index = JSON.parse(await readFile(join(staticDir, 'index.json'), 'utf8'));

  return Object.values(index.entries)
    .filter((entry) => entry.type === 'story')
    .map((entry) => entry.id);
}

/**
 * Loads the story `id` in `page` and collects its console errors, page errors
 * and a visible error overlay.
 *
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 * @param {string} id
 * @returns {Promise<string[]>}
 */
async function storyErrors(page, baseUrl, id) {
  /** @type {string[]} */
  const errors = [];
  /** @param {import('playwright').ConsoleMessage} msg */
  const onConsole = (msg) => {
    if (msg.type() === 'error') errors.push(firstLine(msg.text()));
  };
  /** @param {Error} err */
  const onPageError = (err) => errors.push(`pageerror: ${firstLine(String(err))}`);

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    await page.goto(`${baseUrl}/iframe.html?id=${id}&viewMode=story`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(SETTLE_MS);

    const overlayVisible = await page
      .locator('.sb-show-errordisplay')
      .isVisible()
      .catch(() => false);

    if (overlayVisible) errors.push(OVERLAY_ERROR);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }

  return errors;
}

/**
 * @typedef {object} StoryCheck
 * @property {string} id The story id, as in the build's `index.json`.
 * @property {string[]} errors Its errors, in the order seen; empty when it renders clean.
 */

/**
 * @typedef {object} CheckStoriesOptions
 * @property {() => Promise<import('playwright').Browser>} [launch] Starts the browser; headless Chromium by default.
 * @property {(check: StoryCheck) => void} [onStory] Called with each story's result as soon as it is known.
 */

/**
 * Serves the built Storybook in `staticDir` on `port` (0 picks a free port),
 * loads every story of its `index.json` in a browser, and returns each story
 * id with its errors, in index order. The server and browser are closed
 * before it returns or throws.
 *
 * @param {string} staticDir The Storybook build output.
 * @param {number} port The port to serve it on.
 * @param {CheckStoriesOptions} [options]
 * @returns {Promise<StoryCheck[]>}
 */
export async function checkStories(staticDir, port, options = {}) {
  const { launch = () => chromium.launch(), onStory } = options;
  const storyIds = await readStoryIds(staticDir);
  const server = await serveStaticDir(staticDir, port);

  try {
    const browser = await launch();

    try {
      const page = await browser.newPage();
      /** @type {StoryCheck[]} */
      const checks = [];

      for (const id of storyIds) {
        const check = { id, errors: await storyErrors(page, `http://${LOOPBACK_HOST}:${server.port}`, id) };

        checks.push(check);
        onStory?.(check);
      }

      return checks;
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

/**
 * The command-line entry: checks `argv`'s static dir and port, prints a line
 * per story and a summary, and returns the exit code, 1 when any story errs.
 *
 * @param {readonly string[]} argv The arguments after the script path.
 * @param {CheckStoriesOptions} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  const checks = await checkStories(resolve(argv[0] ?? DEFAULT_STATIC_DIR), Number(argv[1] ?? DEFAULT_PORT), {
    ...options,
    onStory: ({ id, errors }) => console.log(errors.length
      ? `✗ ${id}\n    ${errors.join('\n    ')}`
      : `✓ ${id}`),
  });
  const failures = checks.filter(({ errors }) => errors.length > 0);

  console.log(`\n${checks.length - failures.length}/${checks.length} stories render clean`);

  if (failures.length) {
    console.error(`${failures.length} storie(s) have preview errors`);

    return 1;
  }

  return 0;
}

/**
 * Whether this module is the script being run, rather than an import.
 *
 * @returns {Promise<boolean>}
 */
async function isEntry() {
  if (!process.argv[1]) return false;

  const [self, entry] = await Promise.all([
    realpath(fileURLToPath(import.meta.url)),
    realpath(process.argv[1]).catch(() => ''),
  ]);

  return self === entry;
}

if (await isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}

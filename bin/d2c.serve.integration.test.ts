/**
 * Integration test for `bun run d2c serve`, run as the real package script
 * (`bun run d2c serve [--check]`) rather than by calling {@link run} or
 * spawning `bin/d2c.ts` directly, so it exercises the script wiring in
 * `package.json`, the real `node:http` server and, for `--check`, real
 * headless Chromium.
 *
 * The project points `source.dir` at a temporary copy of `pipeline/serve/
 * fixtures/spaced`, discovered once up front, so both runs walk a page list
 * discovery actually reports. The `projects/<slug>.json` this test writes
 * under the real repo root is gitignored except the tracked `example.json`,
 * so this leaves nothing to commit, and is removed afterwards along with
 * the temporary source dir, even if an assertion fails.
 *
 * The plain `serve` run outlives its own call, so it is spawned
 * asynchronously and stopped with `SIGTERM` once every page has answered,
 * the same signal `bin/d2c.ts`'s entry point listens for.
 *
 * Both runs get `D2C_PORT` set to a port the operating system just assigned
 * (see {@link osAssignedPort}), so neither falls back to the FIRST_PORT range and
 * competes with another test file for it.
 *
 * @packageDocumentation
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../pipeline/assess/discover.ts';
import { serveCheckPath, serveCheckReportSchema } from '../pipeline/serve/check.ts';
import { serveRecordPath } from '../pipeline/serve/serve-record.ts';

/** Generous enough for `bun run d2c serve` to bind a port plus a fetch of every page. */
const SERVE_TIMEOUT_MS = 30_000;

/** Generous enough for a Chromium launch plus a load of every kept page. */
const CHECK_TIMEOUT_MS = 90_000;

const REPO_ROOT = join(import.meta.dirname, '..');

const PROJECTS_DIR = join(REPO_ROOT, 'projects');

const FIXTURE = join(REPO_ROOT, 'pipeline', 'serve', 'fixtures', 'spaced');

function projectPath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.json`);
}

/** A slug unique to this test run, valid under `SLUG_PATTERN`. */
function uniqueSlug(label: string): string {
  return `integration-${label}-${crypto.randomUUID()}`;
}

/** Percent-encodes each segment of a POSIX path relative to `source.dir`. */
function encodePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/** Escapes `text` for use inside a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Spawns `bun run d2c serve [args]` and resolves to the printed address
 * once the "serving" line has arrived on stdout, rejecting if the process
 * exits first. `sourceDir` is matched literally against the line's own
 * directory field, so the address is only ever read off the tool's own
 * output.
 */
function waitForAddress(child: ChildProcessWithoutNullStreams, sourceDir: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const pattern = new RegExp(`d2c serve: serving ${escapeRegExp(sourceDir)} at (http://127\\.0\\.0\\.1:\\d+/)\\n`);

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = pattern.exec(buffer);

      if (match) {
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        resolvePromise(match[1] ?? '');
      }
    };
    const onExit = (code: number | null): void => {
      rejectPromise(new Error(`bun run d2c serve exited early (code ${String(code)}): ${buffer}`));
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

/**
 * Binds a listener to port 0 on 127.0.0.1, reads the port the operating
 * system assigned, closes the listener and resolves to that port, for the
 * child's `D2C_PORT`. `D2C_PORT` refuses 0 itself, hence the round trip.
 */
async function osAssignedPort(): Promise<number> {
  const listener = createServer();

  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const bound = listener.address();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    listener.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });

  if (bound === null || typeof bound === 'string' || bound.port === 0) {
    throw new Error(`port 0 listener reported no port: ${String(bound)}`);
  }

  return bound.port;
}

/** Stops `child` with `SIGTERM` and resolves once it has exited. */
function stopAndWait(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolvePromise) => {
    child.once('exit', (code) => {
      resolvePromise(code);
    });
    child.kill('SIGTERM');
  });
}

describe('bun run d2c serve', () => {
  let workDir: string;
  let slug: string;
  let sourceDir: string;

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(projectPath(slug), { force: true });
  });

  test(
    'serves every discovered page and names itself in .serve.json, then --check exits 0 with no problems',
    async () => {
      workDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-serve-integration-test-'));
      slug = uniqueSlug('serve');
      sourceDir = join(workDir, 'spaced');

      cpSync(FIXTURE, sourceDir, { recursive: true });

      const report = writeDiscovery(sourceDir, discover(sourceDir));

      expect(report.pages.length).toBeGreaterThan(0);

      writeFileSync(projectPath(slug), JSON.stringify({ slug, source: { dir: sourceDir } }));

      const port = await osAssignedPort();
      const env = { ...process.env, D2C_PROJECT: slug, D2C_PORT: String(port) };
      const child = spawn('bun', ['run', 'd2c', 'serve'], { env });

      let address: string;

      try {
        address = await waitForAddress(child, sourceDir);

        expect(address).toBe(`http://127.0.0.1:${String(port)}/`);

        for (const page of report.pages) {
          const response = await fetch(`${address}${encodePath(page.path)}`);

          expect(response.status, page.path).toBe(200);
        }

        expect(JSON.parse(readFileSync(serveRecordPath(sourceDir), 'utf8'))).toMatchObject({ address });

        const exitCode = await stopAndWait(child);

        expect(exitCode).toBe(0);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }

      expect(existsSync(serveRecordPath(sourceDir))).toBe(false);

      const check = spawnSync('bun', ['run', 'd2c', 'serve', '--check'], { encoding: 'utf8', env });

      expect(check.status).toBe(0);
      expect(check.stdout).toContain(`checked ${report.pages.length} pages`);
      expect(check.stdout).toContain('wrote');

      const written = serveCheckReportSchema.parse(JSON.parse(readFileSync(serveCheckPath(sourceDir), 'utf8')));

      expect(written.pages).toHaveLength(report.pages.length);
      for (const page of written.pages) {
        expect(page.consoleErrors, page.path).toEqual([]);
        expect(page.failedRequests, page.path).toEqual([]);
      }
    },
    SERVE_TIMEOUT_MS + CHECK_TIMEOUT_MS,
  );
});

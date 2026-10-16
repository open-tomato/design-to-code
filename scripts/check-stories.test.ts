import type { AddressInfo } from 'node:net';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { checkStories, LOOPBACK_HOST, main, OVERLAY_ERROR, serveStaticDir } from './check-stories.mjs';

/** What a fake story does when the fake page loads it. */
interface StoryScript {
  readonly consoleMessages?: readonly { readonly type: string, readonly text: string }[];
  readonly pageErrors?: readonly string[];
  readonly overlay?: boolean;
  readonly gotoError?: string;
}

/** A fake page's record of what the checker did with it. */
interface FakeRecord {
  readonly statuses: number[];
  readonly listenerCounts: number[];
  closed: boolean;
}

type Listener = (payload: unknown) => void;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp Storybook build whose `index.json` lists `ids` as stories, plus one docs entry. */
function staticDirWith(ids: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-check-stories-'));
  const entries = Object.fromEntries([
    ...ids.map((id) => [id, { id, type: 'story' }]),
    ['button--docs', { id: 'button--docs', type: 'docs' }],
  ]);

  dirs.push(dir);
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ v: 5, entries }));
  writeFileSync(join(dir, 'iframe.html'), '<!doctype html><title>preview</title>');

  return dir;
}

/** A port no server is listening on, found by binding port 0 and closing. */
async function freePort(): Promise<number> {
  const probe = createServer();

  await new Promise<void>((ok) => probe.listen(0, ok));

  const { port } = probe.address() as AddressInfo;

  await new Promise((ok) => probe.close(ok));

  return port;
}

/**
 * A `launch` returning a fake browser whose page fetches each story URL from
 * the checker's real server, then replays that story's `scripts` entry.
 */
function fakeLaunch(scripts: Readonly<Record<string, StoryScript>>) {
  const record: FakeRecord = { statuses: [], listenerCounts: [], closed: false };
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  let current: StoryScript = {};
  const page = {
    on: (event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    off: (event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    },
    goto: async (url: string) => {
      const response = await fetch(url);

      record.statuses.push(response.status);
      current = scripts[new URL(url).searchParams.get('id') ?? ''] ?? {};

      if (current.gotoError) throw new Error(current.gotoError);

      for (const message of current.consoleMessages ?? []) {
        emit('console', { type: () => message.type, text: () => message.text });
      }

      for (const error of current.pageErrors ?? []) emit('pageerror', new Error(error));
    },
    waitForTimeout: async () => {},
    locator: () => ({ isVisible: async () => current.overlay ?? false }),
  };
  const launch = async () => {
    record.listenerCounts.push(0);

    return {
      newPage: async () => page,
      close: async () => {
        record.closed = true;
        record.listenerCounts.push([...listeners.values()].reduce((sum, set) => sum + set.size, 0));
      },
    };
  };

  return { launch: launch as never, record };
}

describe('checkStories', () => {
  test('returns every story id, in index order, with an empty error list when it renders clean', async () => {
    const dir = staticDirWith(['button--primary', 'card--default']);
    const { launch, record } = fakeLaunch({});

    const checks = await checkStories(dir, 0, { launch });

    expect(checks).toEqual([
      { id: 'button--primary', errors: [] },
      { id: 'card--default', errors: [] },
    ]);
    expect(record.statuses).toEqual([200, 200]);
  });

  test('collects console errors, page errors and a visible overlay, each cut to its first line', async () => {
    const dir = staticDirWith(['button--primary', 'card--default']);
    const long = 'x'.repeat(250);
    const { launch } = fakeLaunch({
      'card--default': {
        consoleMessages: [
          { type: 'warning', text: 'ignored warning' },
          { type: 'error', text: 'Failed prop type\n    at Card' },
          { type: 'error', text: long },
        ],
        pageErrors: ['boom\nstack'],
        overlay: true,
      },
    });

    const checks = await checkStories(dir, 0, { launch });

    expect(checks).toEqual([
      { id: 'button--primary', errors: [] },
      {
        id: 'card--default',
        errors: ['Failed prop type', 'x'.repeat(200), 'pageerror: Error: boom', OVERLAY_ERROR],
      },
    ]);
  });

  test('keeps one story\'s errors out of the next story\'s list', async () => {
    const dir = staticDirWith(['a--one', 'b--two']);
    const { launch } = fakeLaunch({ 'a--one': { pageErrors: ['first'] } });

    const checks = await checkStories(dir, 0, { launch });

    expect(checks.map(({ errors }) => errors.length)).toEqual([1, 0]);
  });

  test('reports each result to onStory as it is known', async () => {
    const dir = staticDirWith(['a--one', 'b--two']);
    const { launch } = fakeLaunch({ 'b--two': { overlay: true } });
    const seen: unknown[] = [];

    await checkStories(dir, 0, { launch, onStory: (check) => seen.push(check) });

    expect(seen).toEqual([{ id: 'a--one', errors: [] }, { id: 'b--two', errors: [OVERLAY_ERROR] }]);
  });

  test('closes the browser and removes its listeners when a story fails to load, and rethrows', async () => {
    const dir = staticDirWith(['a--one']);
    const { launch, record } = fakeLaunch({ 'a--one': { gotoError: 'net::ERR_ABORTED' } });

    await expect(checkStories(dir, 0, { launch })).rejects.toThrow('net::ERR_ABORTED');
    expect(record.closed).toBe(true);
    expect(record.listenerCounts.at(-1)).toBe(0);
  });

  test('frees the port it served on, so the same port can be served again', async () => {
    const dir = staticDirWith(['a--one']);
    const port = await freePort();

    await checkStories(dir, port, { launch: fakeLaunch({}).launch });

    await expect(checkStories(dir, port, { launch: fakeLaunch({}).launch })).resolves.toHaveLength(1);
  });

  test('rejects when the port is already taken', async () => {
    const dir = staticDirWith(['a--one']);
    const blocker = createServer();

    await new Promise<void>((ok) => blocker.listen(0, LOOPBACK_HOST, ok));

    try {
      const { port } = blocker.address() as AddressInfo;

      await expect(checkStories(dir, port, { launch: fakeLaunch({}).launch })).rejects.toThrow(); // Node says EADDRINUSE, Bun 'Failed to start server'.
    } finally {
      await new Promise((ok) => blocker.close(ok));
    }
  });

  test('rejects without launching a browser when index.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd2c-check-stories-'));
    const { launch, record } = fakeLaunch({});

    dirs.push(dir);

    await expect(checkStories(dir, 0, { launch })).rejects.toThrow();
    expect(record.listenerCounts).toEqual([]);
  });
});

describe('main', () => {
  test('prints a line per story and the summary, and returns 0 when every story is clean', async () => {
    const dir = staticDirWith(['a--one']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main([dir, '0'], { launch: fakeLaunch({}).launch });

    expect(code).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toEqual(['✓ a--one', '\n1/1 stories render clean']);
  });

  test('prints each failing story with its errors and returns 1 when any story errs', async () => {
    const dir = staticDirWith(['a--one', 'b--two']);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main([dir, '0'], { launch: fakeLaunch({ 'b--two': { pageErrors: ['boom'] } }).launch });

    expect(code).toBe(1);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '✓ a--one',
      '✗ b--two\n    pageerror: Error: boom',
      '\n1/2 stories render clean',
    ]);
    expect(error.mock.calls).toEqual([['1 storie(s) have preview errors']]);
  });
});

describe('serveStaticDir', () => {
  /** A temp dir holding `site/iframe.html` and `secret.txt` beside `site/`; returns `site`. */
  function siteWithSecretBeside(): string {
    const root = mkdtempSync(join(tmpdir(), 'd2c-check-stories-serve-'));
    const site = join(root, 'site');

    dirs.push(root);
    mkdirSync(site);
    writeFileSync(join(site, 'iframe.html'), '<!doctype html><title>preview</title>');
    writeFileSync(join(root, 'secret.txt'), 'SECRET-FILE-CONTENT');

    return site;
  }

  /** Serves `dir` on a free port, fetches `path` from it, and closes the server. */
  async function fetchFrom(dir: string, path: string): Promise<{ status: number, body: string, host: string }> {
    const server = await serveStaticDir(dir, 0);

    try {
      const response = await fetch(`http://${LOOPBACK_HOST}:${server.port}${path}`);

      return { status: response.status, body: await response.text(), host: server.host };
    } finally {
      await server.close();
    }
  }

  test('listens on the loopback interface only', async () => {
    const { host } = await fetchFrom(siteWithSecretBeside(), '/iframe.html');

    expect(LOOPBACK_HOST).toBe('127.0.0.1');
    expect(host).toBe('127.0.0.1');
  });

  test('serves a file inside the dir', async () => {
    const { status, body } = await fetchFrom(siteWithSecretBeside(), '/iframe.html');

    expect(status).toBe(200);
    expect(body).toContain('<title>preview</title>');
  });

  test('refuses an encoded ..%2f traversal with 403 and never reads the file', async () => {
    const { status, body } = await fetchFrom(siteWithSecretBeside(), '/..%2fsecret.txt');

    expect(status).toBe(403);
    expect(body).not.toContain('SECRET-FILE-CONTENT');
  });

  test('refuses a NUL byte and a malformed escape with 400', async () => {
    const site = siteWithSecretBeside();

    expect((await fetchFrom(site, '/iframe.html%00.png')).status).toBe(400);
    expect((await fetchFrom(site, '/%E0%A4%A')).status).toBe(400);
  });

  test('answers 404 for a missing file inside the dir', async () => {
    expect((await fetchFrom(siteWithSecretBeside(), '/missing.js')).status).toBe(404);
  });
});

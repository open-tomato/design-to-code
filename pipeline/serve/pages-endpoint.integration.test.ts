import type { PagesConfig } from './nav.ts';
import type { RunningServer } from './server.ts';
import type { PageChoice, PageChoices } from '../../config/save.ts';
import type { IncomingHttpHeaders } from 'node:http';

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { savePageChoice } from '../../config/save.ts';
import { discover, writeDiscovery } from '../assess/discover.ts';

import { MAX_CURATION_BODY_BYTES } from './pages-endpoint.ts';
import { startServer } from './server.ts';

let workDir: string;
let sourceDir: string;
let running: RunningServer[];

async function start(options: Omit<Parameters<typeof startServer>[0], 'sourceDir'> = {}): Promise<RunningServer> {
  const server = await startServer({ sourceDir, env: {}, port: 0, ...options });

  running.push(server);

  return server;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-pages-endpoint-test-'));
  sourceDir = join(workDir, 'source');
  mkdirSync(sourceDir, { recursive: true });
  running = [];
});

afterEach(async () => {
  await Promise.all(running.map((server) => server.stop()));
  rmSync(workDir, { recursive: true, force: true });
});

const V1 = 'Rafa Portal.dc.html';
const V2 = 'Rafa Portal v2.dc.html';
const ABOUT = 'about.html';

/** A page whose last `</BODY>` is upper case and follows an earlier one in a comment. */
const PAGE = '<!doctype html>\n<html><head><title>Portal</title></head>\n<body><!-- </body> -->\n<h1>Portal</h1>\n</BODY>\n</html>\n';

/** Fetches `url` on a socket that is never pooled across server instances. */
function fetchOnce(url: string, init: { readonly method?: string } = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { connection: 'close' } });
}

/** Writes three pages and a `discovery.json` grouping two of them as versions. */
function writePagesAndDiscovery(): void {
  writeFileSync(join(sourceDir, V1), PAGE);
  writeFileSync(join(sourceDir, V2), PAGE);
  writeFileSync(join(sourceDir, ABOUT), '<p>about</p>\n');

  const report = discover(sourceDir, { now: new Date('2026-09-30T12:00:00.000Z') });

  writeDiscovery(sourceDir, { ...report, agentNotes: { ...report.agentNotes, versionGroups: [[V2, V1]] } });
}

describe('startServer GET /__d2c/pages', () => {
  test('answers the nav model from discovery.json, every page kept by default', async () => {
    writePagesAndDiscovery();
    const server = await start();
    const response = await fetchOnce(`${server.address}__d2c/pages`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({
      groups: [{
        pages: [
          { path: V2, title: 'Portal', state: 'kept' },
          { path: V1, title: 'Portal', state: 'kept' },
        ],
      }],
      ungrouped: [{ path: ABOUT, title: null, state: 'kept' }],
    });
  });

  test('reads the config pages afresh for every request', async () => {
    writePagesAndDiscovery();
    let pages: PagesConfig = { discard: [V1] };
    const server = await start({ readPages: () => pages });
    const states = async (): Promise<unknown> => {
      const model = await (await fetchOnce(`${server.address}__d2c/pages`)).json() as { groups: { pages: { state: string }[] }[] };

      return model.groups[0]?.pages.map((page) => page.state);
    };

    expect(await states()).toEqual(['kept', 'discarded']);

    pages = { keep: [V1], discard: [V2] };

    expect(await states()).toEqual(['discarded', 'kept']);
  });

  test('answers the model, not a file the export holds at that path', async () => {
    writePagesAndDiscovery();
    mkdirSync(join(sourceDir, '__d2c'));
    writeFileSync(join(sourceDir, '__d2c', 'pages'), 'from disk');
    const server = await start();
    const response = await fetchOnce(`${server.address}__d2c/pages?d2c-nav=0`);

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('from disk');
  });

  test('answers 404 naming the assess step while there is no discovery.json', async () => {
    const server = await start();
    const response = await fetchOnce(`${server.address}__d2c/pages`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('bun run d2c assess --scripts-only');
  });

  test('answers 500 for a discovery.json that fails its schema', async () => {
    writeFileSync(join(sourceDir, 'discovery.json'), '{"pages": 1}\n');
    const server = await start();

    expect((await fetchOnce(`${server.address}__d2c/pages`)).status).toBe(500);
  });
});

const SLUG = 'serve-demo';

/** The config the curation tests start from, as written. */
const CONFIG = { slug: SLUG, source: { dir: 'source' }, name: 'Serve demo' };

interface PostResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function configPath(): string {
  return join(workDir, 'projects', `${SLUG}.json`);
}

function writeConfig(): void {
  mkdirSync(join(workDir, 'projects'), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(CONFIG, null, 2)}\n`);
}

function readConfigText(): string {
  return readFileSync(configPath(), 'utf8');
}

/** The real config writer, bound to the temporary project. */
function saveToConfig(page: string, choice: PageChoice): PageChoices {
  return savePageChoice(SLUG, page, choice, { rootDir: workDir });
}

/**
 * Sends one request over its own socket with `node:http`, which, unlike
 * `fetch`, sends an `Origin` header exactly as given.
 */
function send(
  server: RunningServer,
  body: string,
  headers: Readonly<Record<string, string>> = {},
  method = 'POST',
): Promise<PostResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = request(`${server.address}__d2c/pages`, {
      method,
      agent: false,
      headers: { 'content-type': 'application/json', ...headers },
    }, (incoming) => {
      const chunks: Buffer[] = [];

      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolvePromise({
        status: incoming.statusCode ?? 0,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      incoming.on('error', rejectPromise);
    });

    outgoing.on('error', rejectPromise);
    outgoing.end(body);
  });
}

function choose(server: RunningServer, page: string, choice: string, headers?: Readonly<Record<string, string>>): Promise<PostResult> {
  return send(server, JSON.stringify({ page, choice }), headers);
}

describe('startServer POST /__d2c/pages', () => {
  beforeEach(() => {
    writePagesAndDiscovery();
    writeConfig();
  });

  test('keep writes the page to pages.keep and answers both lists', async () => {
    const server = await start({ savePage: saveToConfig });
    const result = await choose(server, V1, 'keep');

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(result.body)).toStrictEqual({ keep: [V1], discard: [] });
    expect(JSON.parse(readConfigText())).toStrictEqual({ ...CONFIG, pages: { keep: [V1] } });
  });

  test('discard writes the page to pages.discard, moving it out of pages.keep', async () => {
    const server = await start({ savePage: saveToConfig });

    expect((await choose(server, V1, 'keep')).status).toBe(200);

    const result = await choose(server, V1, 'discard');

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toStrictEqual({ keep: [], discard: [V1] });
    expect(JSON.parse(readConfigText())).toStrictEqual({ ...CONFIG, pages: { keep: [], discard: [V1] } });
  });

  test('answers 400 for a page discovery.json does not list, leaving the config as written', async () => {
    const before = readConfigText();
    const server = await start({ savePage: saveToConfig });
    const result = await choose(server, 'not-discovered.html', 'discard');

    expect(result.status).toBe(400);
    expect(result.body).toContain('not a discovered page: not-discovered.html');
    expect(readConfigText()).toBe(before);
  });

  test('answers 403 for a foreign Origin, leaving the config as written, and 200 for its own', async () => {
    const before = readConfigText();
    const server = await start({ savePage: saveToConfig });
    const ownOrigin = server.address.slice(0, -1);
    // Any other port makes a foreign origin; the bound port is nonzero, so this is never negative.
    const foreignPort = server.port - 1;

    for (const origin of ['https://evil.example', `http://localhost:${server.port}`, `http://127.0.0.1:${foreignPort}`, 'null']) {
      const result = await choose(server, V1, 'discard', { origin });

      expect(result.status, origin).toBe(403);
    }

    expect(readConfigText()).toBe(before);

    // Control: the same request from the server's own origin is written.
    expect((await choose(server, V1, 'discard', { origin: ownOrigin })).status).toBe(200);
    expect(JSON.parse(readConfigText())).toStrictEqual({ ...CONFIG, pages: { discard: [V1] } });
  });

  test('two concurrent posts for different pages both land in the config', async () => {
    const server = await start({ savePage: saveToConfig });
    const [first, second] = await Promise.all([choose(server, V1, 'keep'), choose(server, V2, 'discard')]);

    expect([first?.status, second?.status]).toEqual([200, 200]);
    expect(JSON.parse(readConfigText())).toStrictEqual({ ...CONFIG, pages: { keep: [V1], discard: [V2] } });
  });

  test('runs one write at a time, even when the writer is asynchronous', async () => {
    let inFlight = 0;
    let most = 0;
    const slowSave = async (page: string, choice: PageChoice): Promise<PageChoices> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

      try {
        return saveToConfig(page, choice);
      } finally {
        inFlight -= 1;
      }
    };

    // Control: called directly, the slow writer overlaps, so the counter can
    // see an overlap the server would have let through.
    await Promise.all([slowSave(ABOUT, 'keep'), slowSave(ABOUT, 'keep')]);
    expect(most).toBe(2);
    most = 0;

    const server = await start({ savePage: slowSave });
    const results = await Promise.all([choose(server, V1, 'keep'), choose(server, V2, 'discard'), choose(server, ABOUT, 'discard')]);

    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(most).toBe(1);
    expect(JSON.parse(readConfigText())).toStrictEqual({ ...CONFIG, pages: { keep: [V1], discard: [V2, ABOUT] } });
  });

  test('answers 500 when the writer throws, and the next write still runs', async () => {
    let calls = 0;
    const flaky = (page: string, choice: PageChoice): PageChoices => {
      calls += 1;

      if (calls === 1) {
        throw new Error('disk full');
      }

      return saveToConfig(page, choice);
    };
    const server = await start({ savePage: flaky });

    const failed = await choose(server, V1, 'keep');

    expect(failed.status).toBe(500);
    expect(failed.body).toContain('disk full');
    expect((await choose(server, V2, 'keep')).status).toBe(200);
    expect(JSON.parse(readConfigText())).toStrictEqual({ ...CONFIG, pages: { keep: [V2] } });
  });

  test.each([
    ['not JSON', '{page'],
    ['an array', '[]'],
    ['no page', JSON.stringify({ choice: 'keep' })],
    ['an empty page', JSON.stringify({ page: '', choice: 'keep' })],
    ['an unknown choice', JSON.stringify({ page: V1, choice: 'maybe' })],
  ])('answers 400 for a body that is %s', async (_label, body) => {
    const before = readConfigText();
    const server = await start({ savePage: saveToConfig });

    expect((await send(server, body)).status).toBe(400);
    expect(readConfigText()).toBe(before);
  });

  test('answers 413 for a body over the limit', async () => {
    const server = await start({ savePage: saveToConfig });
    const body = JSON.stringify({ page: 'x'.repeat(MAX_CURATION_BODY_BYTES), choice: 'keep' });

    expect((await send(server, body)).status).toBe(413);
  });

  test('answers 404 naming the assess step while there is no discovery.json', async () => {
    rmSync(join(sourceDir, 'discovery.json'));
    const server = await start({ savePage: saveToConfig });
    const result = await choose(server, V1, 'keep');

    expect(result.status).toBe(404);
    expect(result.body).toContain('bun run d2c assess --scripts-only');
  });

  test('answers 405 allowing GET, HEAD, POST for another method', async () => {
    const server = await start({ savePage: saveToConfig });
    const result = await send(server, '', {}, 'PUT');

    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD, POST');
  });

  test('answers 405 allowing GET, HEAD when no writer was given', async () => {
    const before = readConfigText();
    const server = await start();
    const result = await choose(server, V1, 'keep');

    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD');
    expect(readConfigText()).toBe(before);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { LOOPBACK_HOSTNAME, staticHandler, startStaticServer } from './serve-static.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp dir holding `site/index.html`, `site/app.js`, and `secret.txt` beside `site/`. */
function siteWithSecretBeside(): string {
  const root = mkdtempSync(join(tmpdir(), 'd2c-serve-static-'));
  const site = join(root, 'site');

  dirs.push(root);
  mkdirSync(site);
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>home</title>');
  writeFileSync(join(site, 'app.js'), 'export {};');
  writeFileSync(join(root, 'secret.txt'), 'SECRET-FILE-CONTENT');

  return site;
}

describe('staticHandler', () => {
  test('serves a file inside the dir with its content type', async () => {
    const handle = staticHandler(siteWithSecretBeside());

    const response = await handle(new Request('http://127.0.0.1/app.js'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toBe('export {};');
  });

  test('serves index.html for /', async () => {
    const handle = staticHandler(siteWithSecretBeside());

    const response = await handle(new Request('http://127.0.0.1/'));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>home</title>');
  });

  test('refuses an encoded ..%2f traversal with 403 and never reads the file', async () => {
    const handle = staticHandler(siteWithSecretBeside());

    const response = await handle(new Request('http://127.0.0.1/..%2fsecret.txt'));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('SECRET-FILE-CONTENT');
  });

  test('refuses a NUL byte with 400', async () => {
    const handle = staticHandler(siteWithSecretBeside());

    const response = await handle(new Request('http://127.0.0.1/app.js%00.png'));

    expect(response.status).toBe(400);
  });

  test('answers 404 for a missing file inside the dir', async () => {
    const handle = staticHandler(siteWithSecretBeside());

    const response = await handle(new Request('http://127.0.0.1/missing.js'));

    expect(response.status).toBe(404);
  });
});

describe('startStaticServer', () => {
  test('binds the loopback interface only', () => {
    const calls: { hostname?: string, port?: number }[] = [];

    startStaticServer('site', 6016, (options) => {
      calls.push(options);
    });

    expect(LOOPBACK_HOSTNAME).toBe('127.0.0.1');
    expect(calls).toEqual([expect.objectContaining({ hostname: '127.0.0.1', port: 6016 })]);
  });
});

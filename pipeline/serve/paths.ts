/**
 * Request-path handling for the serve verb: turns the raw request target a
 * `node:http` server hands through as `req.url` into a file under the
 * project's `source.dir`, or into a refusal, and names the content type a
 * served file answers with.
 *
 * The target is read raw, never through `new URL()`, which drops dot
 * segments before a containment check could see them. The query and
 * fragment are split off, the path is percent-decoded once (a malformed
 * escape or a NUL byte answers 400), resolved against `source.dir`, and
 * refused with 403 when it lands outside it. A request for a directory maps
 * to that directory's `index.html`. Whether the mapped file exists is the
 * server's question, not this module's.
 *
 * @packageDocumentation
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The file a directory request maps to. */
export const INDEX_FILE = 'index.html';

/** The content type for any extension {@link CONTENT_TYPES} does not list. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const HTML = 'text/html; charset=utf-8';

const JAVASCRIPT = 'text/javascript; charset=utf-8';

/**
 * Content types by lowercase file extension. `.dc.html` needs no entry of
 * its own: its extension is `.html`. Script sources a page loads through
 * `type="text/babel"` (`.jsx`, `.ts`, `.tsx`) answer as JavaScript, as the
 * in-browser transpiler that fetches them expects.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': HTML,
  '.htm': HTML,
  '.js': JAVASCRIPT,
  '.mjs': JAVASCRIPT,
  '.jsx': JAVASCRIPT,
  '.ts': JAVASCRIPT,
  '.tsx': JAVASCRIPT,
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** A request target that maps to a file under `source.dir`. */
export interface ResolvedFile {
  readonly kind: 'file';
  /** The absolute path of the file to serve. */
  readonly filePath: string;
  /** The same path, POSIX-relative to `source.dir`. */
  readonly relativePath: string;
}

/** A request target the server refuses before touching the file system. */
export interface RefusedRequest {
  readonly kind: 'refused';
  /** 400 for a target that cannot be decoded, 403 for one outside `source.dir`. */
  readonly status: 400 | 403;
  /** Why the target was refused, for the response body and the log. */
  readonly reason: string;
}

/** What {@link resolveRequestPath} makes of a request target. */
export type RequestResolution = ResolvedFile | RefusedRequest;

function refuse(status: 400 | 403, reason: string): RefusedRequest {
  return { kind: 'refused', status, reason };
}

/** Returns the target's path part, without its query or fragment. */
function pathPart(rawTarget: string): string {
  const end = rawTarget.search(/[?#]/);

  return end === -1
    ? rawTarget
    : rawTarget.slice(0, end);
}

/** Whether `candidate` is `root` itself or a path below it. */
function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);

  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

function isDirectory(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isDirectory();
}

/**
 * Maps a raw request target to a file under `sourceDir`.
 *
 * `rawTarget` is `req.url` as `node:http` hands it through, such as
 * `/app%20parts/page.js?v=2`. It answers:
 *
 * - 400 when the target is not origin-form (does not start with `/`), when a
 *   percent escape is malformed, or when the decoded path holds a NUL byte;
 * - 403 when the decoded path resolves outside `sourceDir` (`/../x`,
 *   `/..%2fx`, `/%2e%2e/x`), or when an existing file or directory it names
 *   is a symlink whose real path lies outside `sourceDir`;
 * - otherwise the file, with a path ending in `/` or naming an existing
 *   directory mapped to that directory's {@link INDEX_FILE}.
 */
export function resolveRequestPath(sourceDir: string, rawTarget: string): RequestResolution {
  const rawPath = pathPart(rawTarget);

  if (!rawPath.startsWith('/')) {
    return refuse(400, `request target must start with "/": ${rawTarget}`);
  }

  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return refuse(400, `malformed percent-encoding in ${rawPath}`);
  }

  if (decodedPath.includes('\0')) {
    return refuse(400, `NUL byte in ${rawPath}`);
  }

  const root = resolve(sourceDir);
  const target = resolve(root, `.${decodedPath}`);

  if (!isInside(root, target)) {
    return refuse(403, `${rawPath} resolves outside the source dir`);
  }

  const filePath = decodedPath.endsWith('/') || isDirectory(target)
    ? join(target, INDEX_FILE)
    : target;

  if (existsSync(filePath) && !isInside(realpathSync(root), realpathSync(filePath))) {
    return refuse(403, `${rawPath} links outside the source dir`);
  }

  return {
    kind: 'file',
    filePath,
    relativePath: relative(root, filePath)
      .split(sep)
      .join('/'),
  };
}

/**
 * Names the content type for `filePath` from its extension, case-blind,
 * falling back to {@link DEFAULT_CONTENT_TYPE}.
 */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

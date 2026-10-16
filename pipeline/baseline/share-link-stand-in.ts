/**
 * Local stand-ins for a Claude Design share link, for the browser tests of
 * `share-link.ts` and of confirm: `node:http` servers on `127.0.0.1` that
 * play the design project, a login wall, and a link that redirects to one.
 *
 * A `design` stand-in answers its {@link RunningStandIn.shareLink} with a
 * project page, and any page path below it with that page's Claude Design
 * view: chrome (a {@link HEADER_HEIGHT} px header bar across the top and a
 * {@link SIDE_PANEL_WIDTH} px side panel down the left, both in solid
 * colours) around a borderless `iframe` filling the rest, whose `src` is
 * the page served by the design server at `designAddress` with the nav bar
 * off. The side panel also holds a small visible thumbnail `iframe`, and a
 * `visibility: hidden` `iframe` covers the whole viewport, so only a check
 * that picks the largest visible frame finds the design. With `frame` off
 * the view keeps its chrome but shows the design in a plain `div` and
 * holds no `iframe` at all, thumbnail and hidden frame included.
 *
 * A `login` stand-in answers every request with a sign-in page and
 * `status`; a `redirect` stand-in answers every request with a 302 to
 * `location`. A share link that redirects to a login wall on another port
 * ends on another origin, as a real login redirect does.
 *
 * Every stand-in listens on a port the system picks, so it never competes
 * with the serve verb's 4600 range.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { createServer } from 'node:http';

import { checkUrl } from '../serve/check.ts';

/** The share link's path on a `design` stand-in; page views resolve below it. */
export const SHARE_PATH = '/design/p/stand-in-project/';

/** Height of the view's header bar, in CSS pixels. */
export const HEADER_HEIGHT = 48;

/** Width of the view's side panel, in CSS pixels. */
export const SIDE_PANEL_WIDTH = 240;

/** The interface every stand-in binds. */
const STAND_IN_HOST = '127.0.0.1';

/** A stand-in for a public design project. */
export interface DesignStandInOptions {
  readonly mode: 'design';
  /** Base URL of the server holding the design's copy of the export. */
  readonly designAddress: string;
  /** Whether the view holds the design in an `iframe`; `false` plays a view with no frame. */
  readonly frame: boolean;
}

/** A stand-in for a login wall. */
export interface LoginStandInOptions {
  readonly mode: 'login';
  /** The status every request is answered with. */
  readonly status: number;
}

/** A stand-in that redirects every request. */
export interface RedirectStandInOptions {
  readonly mode: 'redirect';
  /** The absolute URL every request is redirected to. */
  readonly location: string;
}

/** What a stand-in plays. */
export type StandInOptions = DesignStandInOptions | LoginStandInOptions | RedirectStandInOptions;

/** A running stand-in. */
export interface RunningStandIn {
  /** The base URL, such as `http://127.0.0.1:39001/`. */
  readonly address: string;
  /** The share link: {@link SHARE_PATH} under {@link address}. */
  readonly shareLink: string;
  /** Closes the server, dropping open connections. */
  stop(): Promise<void>;
}

/** Writes an HTML response. */
function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
}

/** A whole HTML document with `title`, `style` and `body`. */
function htmlDocument(title: string, style: string, body: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n<style>${style}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** The view's chrome: header, side panel, and the design's cell filling the rest. */
const VIEW_STYLE = [
  'html, body { margin: 0; height: 100%; font-family: sans-serif; }',
  `body { display: grid; grid-template-columns: ${SIDE_PANEL_WIDTH}px 1fr; grid-template-rows: ${HEADER_HEIGHT}px 1fr; }`,
  'header { grid-column: 1 / 3; background: rgb(31, 31, 31); color: rgb(255, 255, 255); }',
  'aside { background: rgb(240, 237, 230); }',
  'main { min-width: 0; min-height: 0; }',
  '.design { display: block; width: 100%; height: 100%; border: 0; }',
  '.thumb { display: block; width: 200px; height: 120px; border: 0; }',
  '.hidden { visibility: hidden; position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; }',
].join('\n');

/** The Claude Design view of page `path`, with or without its frame. */
function viewHtml(options: DesignStandInOptions, path: string): string {
  if (!options.frame) {
    return htmlDocument('Claude Design', VIEW_STYLE, [
      '<header>Claude Design</header>',
      '<aside><p>Pages</p></aside>',
      '<main><div class="design">The design renders here without a frame.</div></main>',
    ].join('\n'));
  }

  return htmlDocument('Claude Design', VIEW_STYLE, [
    '<header>Claude Design</header>',
    '<aside><p>Pages</p><iframe class="thumb" title="Thumbnail" srcdoc="<p>thumbnail</p>"></iframe></aside>',
    `<main><iframe class="design" title="Design" src="${checkUrl(options.designAddress, path)}"></iframe></main>`,
    '<iframe class="hidden" title="Hidden" srcdoc="<p>hidden</p>"></iframe>',
  ].join('\n'));
}

/** The page path a view request names, or `null` when it names none. */
function viewPath(requestUrl: string): string | null {
  const { pathname } = new URL(requestUrl, 'http://stand-in.invalid');

  if (!pathname.startsWith(SHARE_PATH) || pathname === SHARE_PATH) {
    return null;
  }

  return pathname
    .slice(SHARE_PATH.length)
    .split('/')
    .map(decodeURIComponent)
    .join('/');
}

/** Answers one request as `options` plays it. */
function answer(options: StandInOptions, request: IncomingMessage, response: ServerResponse): void {
  if (options.mode === 'redirect') {
    response.writeHead(302, { Location: options.location, 'Cache-Control': 'no-store' });
    response.end();

    return;
  }

  if (options.mode === 'login') {
    sendHtml(response, options.status, htmlDocument('Sign in', '', '<h1>Sign in to continue</h1>'));

    return;
  }

  const url = request.url ?? '/';
  const path = viewPath(url);

  if (path !== null) {
    sendHtml(response, 200, viewHtml(options, path));

    return;
  }

  if (new URL(url, 'http://stand-in.invalid').pathname === SHARE_PATH) {
    sendHtml(response, 200, htmlDocument('Stand-in project', '', '<h1>Stand-in project</h1>'));

    return;
  }

  sendHtml(response, 404, htmlDocument('Not found', '', '<h1>Not found</h1>'));
}

/** Resolves once `server` listens on a system-picked port of {@link STAND_IN_HOST}. */
function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen({ port: 0, host: STAND_IN_HOST }, () => {
      server.off('error', rejectPromise);

      const bound = server.address();

      if (bound === null || typeof bound === 'string') {
        rejectPromise(new Error('stand-in bound no TCP port'));

        return;
      }

      resolvePromise(bound.port);
    });
  });
}

/** Closes `server` and drops its open connections. */
function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);

        return;
      }

      resolvePromise();
    });
    server.closeAllConnections();
  });
}

/**
 * Starts a stand-in playing `options` on `127.0.0.1` at a system-picked port.
 *
 * @param options - What the stand-in plays: a design project, a login
 *   wall, or a redirect.
 * @returns Its address, its share link and `stop()`.
 * @throws Error when the server cannot listen.
 */
export async function startStandIn(options: StandInOptions): Promise<RunningStandIn> {
  const server = createServer((request, response) => {
    answer(options, request, response);
  });
  const port = await listen(server);
  const address = `http://${STAND_IN_HOST}:${port}/`;

  return {
    address,
    shareLink: new URL(SHARE_PATH, address).href,
    stop: () => close(server),
  };
}

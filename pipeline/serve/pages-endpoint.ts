/**
 * The serve verb's `/__d2c/pages` endpoint: the nav model on `GET`
 * (`nav.ts` builds it from a fresh `discovery.json` read and the project
 * config's `pages`), and, when curation is on, a page's keep or discard
 * choice on `POST`.
 *
 * {@link handlePages} runs the config writer passed in as `context.save`
 * (wrapped by {@link serialize}) one call at a time, so writes never overlap
 * and each re-reads the config the previous one wrote.
 *
 * @packageDocumentation
 */

import type { PagesConfig } from './nav.ts';
import type { PageChoice, PageChoices } from '../../config/save.ts';
import type { DiscoveryReport } from '../assess/schema.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readFile } from 'node:fs/promises';

import { PAGE_CHOICES } from '../../config/save.ts';
import { discoveryPath } from '../assess/discover.ts';
import { discoveryReportSchema } from '../assess/schema.ts';

import { buildNavModel } from './nav.ts';
import { isNotFound, refuseMethod, sendJson, sendText } from './respond.ts';

/** The command that writes the `discovery.json` the page list is read from. */
const DISCOVERY_COMMAND = 'bun run d2c assess --scripts-only';

/** The methods `/__d2c/pages` answers while curation is off. */
const READ_ONLY_METHODS = 'GET, HEAD';

/** The methods `/__d2c/pages` answers while curation is on. */
const CURATION_METHODS = 'GET, HEAD, POST';

/** The largest curation request body read, in bytes; a larger one answers 413. */
export const MAX_CURATION_BODY_BYTES = 64 * 1024;

/** Runs `savePage` calls one at a time, in the order they were queued. */
export type SaveQueue = (page: string, choice: PageChoice) => Promise<PageChoices>;

/** What {@link handlePages} needs from the server's request context. */
export interface PagesEndpointContext {
  /** The directory to serve: the project's `source.dir`. */
  readonly sourceDir: string;
  /** Reads the project config's `pages`, called afresh for every `GET`. */
  readonly readPages: () => PagesConfig;
  /** The serialized config writer, or undefined while curation is off. */
  readonly save: SaveQueue | undefined;
  /** The server's own origin, such as `http://127.0.0.1:4600`, once bound. */
  readonly origin: () => string;
}

/** A curation request body that is not `{ page, choice }` as expected. */
class CurationRequestError extends Error {
  /** The status the request answers. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CurationRequestError';
    this.status = status;
  }
}

/**
 * Reads `discovery.json` fresh, answering 404 naming the assess step and
 * resolving undefined when there is none yet.
 *
 * @throws Error when `discovery.json` cannot be read or parsed, or fails
 * its schema.
 */
async function readDiscovery(sourceDir: string, response: ServerResponse): Promise<DiscoveryReport | undefined> {
  let text: string;

  try {
    text = await readFile(discoveryPath(sourceDir), 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      sendText(response, 404, `no discovery.json in ${sourceDir}; run \`${DISCOVERY_COMMAND}\` first`);

      return undefined;
    }

    throw error;
  }

  return discoveryReportSchema.parse(JSON.parse(text));
}

/**
 * Answers `GET /__d2c/pages` with the nav model built from a fresh read of
 * `discovery.json` and of the config's `pages`, or 404 when there is no
 * `discovery.json` yet.
 *
 * @throws Error when `discovery.json` cannot be read or parsed, or fails
 * its schema.
 */
async function servePages(context: PagesEndpointContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const report = await readDiscovery(context.sourceDir, response);

  if (report !== undefined) {
    sendJson(request, response, buildNavModel(report, context.readPages()));
  }
}

/** Reads the request body, refusing one past {@link MAX_CURATION_BODY_BYTES}. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;

    length += buffer.byteLength;

    if (length > MAX_CURATION_BODY_BYTES) {
      throw new CurationRequestError(413, `request body is over ${MAX_CURATION_BODY_BYTES} bytes`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function isPageChoice(value: unknown): value is PageChoice {
  return PAGE_CHOICES.some((choice) => choice === value);
}

/**
 * Parses a curation body: a JSON object whose `page` is a non-empty string
 * and whose `choice` is `keep` or `discard`.
 *
 * @throws CurationRequestError with status 400 for anything else.
 */
function parseCuration(text: string): { readonly page: string; readonly choice: PageChoice } {
  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new CurationRequestError(400, `request body is not JSON: ${(error as Error).message}`);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CurationRequestError(400, 'request body must be an object { page, choice }');
  }

  const { page, choice } = body as Record<string, unknown>;

  if (typeof page !== 'string' || page === '') {
    throw new CurationRequestError(400, 'page must be a non-empty string');
  }

  if (!isPageChoice(choice)) {
    throw new CurationRequestError(400, `choice must be one of ${PAGE_CHOICES.join(', ')}`);
  }

  return { page, choice };
}

/**
 * Answers `POST /__d2c/pages`: 403 when the request carries an `Origin`
 * other than the server's own, 413 for a body over
 * {@link MAX_CURATION_BODY_BYTES}, 400 for a body that is not
 * `{ page, choice }` or a page `discovery.json` does not list, 404 while
 * there is no `discovery.json`, and otherwise 200 with both lists as the
 * serialized writer wrote them.
 *
 * @throws Error when `discovery.json` cannot be read or fails its schema,
 * or the error the config writer threw.
 */
async function curatePage(
  context: PagesEndpointContext,
  save: SaveQueue,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { origin } = request.headers;

  if (origin !== undefined && origin !== context.origin()) {
    sendText(response, 403, `refused a curation request from origin ${origin}`);

    return;
  }

  let curation: ReturnType<typeof parseCuration>;

  try {
    curation = parseCuration(await readBody(request));
  } catch (error) {
    if (error instanceof CurationRequestError) {
      sendText(response, error.status, error.message);

      return;
    }

    throw error;
  }

  const report = await readDiscovery(context.sourceDir, response);

  if (report === undefined) {
    return;
  }

  if (!report.pages.some((entry) => entry.path === curation.page)) {
    sendText(response, 400, `not a discovered page: ${curation.page}`);

    return;
  }

  sendJson(request, response, await save(curation.page, curation.choice));
}

/**
 * Wraps `savePage` so each call starts only after the previous one has
 * settled, whether it resolved or threw.
 */
export function serialize(savePage: (page: string, choice: PageChoice) => PageChoices | Promise<PageChoices>): SaveQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return (page, choice) => {
    const next = tail.then(() => savePage(page, choice));

    tail = next.catch(() => undefined);

    return next;
  };
}

/**
 * Answers `/__d2c/pages`: the nav model on `GET` or `HEAD`, curation on
 * `POST` when `context.save` is set. Answers 405 for any other method,
 * allowing `GET, HEAD` while curation is off and `GET, HEAD, POST` while it
 * is on.
 */
export async function handlePages(context: PagesEndpointContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { method } = request;

  if (method === 'GET' || method === 'HEAD') {
    await servePages(context, request, response);

    return;
  }

  if (context.save === undefined) {
    refuseMethod(response, method, READ_ONLY_METHODS);

    return;
  }

  if (method !== 'POST') {
    refuseMethod(response, method, CURATION_METHODS);

    return;
  }

  await curatePage(context, context.save, request, response);
}

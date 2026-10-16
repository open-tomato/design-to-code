/**
 * Response helpers shared by the serve verb's `node:http` request handlers
 * (`server.ts`, `pages-endpoint.ts`): writing a plain-text or JSON body, and
 * refusing a method with the right `Allow` header.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** File-system error codes that mean the requested file is not there. */
const NOT_FOUND_CODES: readonly string[] = ['ENOENT', 'ENOTDIR', 'EISDIR'];

/** Whether `error` is a file-system error meaning the target is not there. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && NOT_FOUND_CODES.includes(error.code);
}

/** Writes a `text/plain` response body with a trailing newline. */
export function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(`${text}\n`);
}

/** Writes `body` as a 200 response with `contentType`, omitting the body for `HEAD`. */
export function sendBody(request: IncomingMessage, response: ServerResponse, contentType: string, body: Buffer): void {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(request.method === 'HEAD'
    ? undefined
    : body);
}

/** Writes `value` as a 200 `application/json` response through {@link sendBody}. */
export function sendJson(request: IncomingMessage, response: ServerResponse, value: unknown): void {
  sendBody(request, response, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(value), 'utf8'));
}

/** Answers 405 with an `Allow: allowed` header, naming the refused `method`. */
export function refuseMethod(response: ServerResponse, method: string | undefined, allowed: string): void {
  response.setHeader('Allow', allowed);
  sendText(response, 405, `method not allowed: ${method}`);
}

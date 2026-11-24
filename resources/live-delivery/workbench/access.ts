import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRequestBody } from './request-body.js';

function equal(actual: unknown, expected: string): boolean {
  return (
    typeof actual === 'string' &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

export function previewSignature(
  token: string,
  scope: string,
  id: string,
  version: string | number,
) {
  return createHmac('sha256', token).update(`preview\0${scope}\0${id}\0${version}`).digest('hex');
}

/** The fragment stays out of HTTP request URLs and referrers. It is exchanged for a cookie. */
export function accessLink(url: string, token?: string): string {
  return token ? `${url}#access=${token}` : url;
}

function entryPage(endpoint: string, nonce: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Delivery · 持续交付</title>
<style nonce="${nonce}">body{margin:0;background:#f8f8fa;color:#27272a;font:16px/1.7 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:560px;padding:32px}h1{font-size:24px}p{color:#62626b}</style>
<main><h1>持续交付 · Live Delivery</h1><p id="message">请打开 CLI 最新输出的完整工作台链接。<br>Open the complete workbench link from your CLI.</p></main>
<script nonce="${nonce}">
const access = new URLSearchParams(location.hash.slice(1)).get('access');
history.replaceState(null, '', location.pathname + location.search);
if (access) {
  document.getElementById('message').textContent = '正在连接工作台… Connecting…';
  fetch(${JSON.stringify(endpoint)}, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({access})})
    .then(response => {if (!response.ok) throw Error(); location.reload();})
    .catch(() => {document.getElementById('message').textContent = '链接已失效，请打开 CLI 最新输出的链接。 Link expired. Open the latest link from your CLI.';});
}
</script></html>`;
}

/** Per-host access, separate from CSRF and model credentials. Restarting revokes old links. */
export class WorkbenchAccess {
  readonly token: string;
  private readonly cookieName: string;
  private readonly authorized = new WeakSet<IncomingMessage>();

  constructor(
    readonly basePath: string,
    token = randomBytes(32).toString('hex'),
  ) {
    this.token = token;
    this.cookieName = 'cd_access_' + createHash('sha256').update(token).digest('hex').slice(0, 12);
  }

  private sessionSignature(expires: string) {
    return createHmac('sha256', this.token)
      .update('browser-session\0' + expires)
      .digest('hex');
  }
  private validSession(cookie?: string) {
    const match = /^(\d+)\.([a-f0-9]{64})$/.exec(cookie ?? '');
    return (
      !!match &&
      Number(match[1]) > Math.floor(Date.now() / 1000) &&
      equal(match[2], this.sessionSignature(match[1]))
    );
  }

  async check(req: IncomingMessage, res: ServerResponse, origin: string): Promise<boolean> {
    if (this.authorized.has(req)) return true; // Same request delegated to a scoped view.
    const url = new URL(req.url ?? '/', origin);
    const route = url.pathname;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (route === this.basePath + '/api/access') {
      let accepted = false;
      if (
        req.method === 'POST' &&
        req.headers.origin === origin &&
        req.headers['content-type']?.startsWith('application/json')
      ) {
        try {
          accepted = equal(JSON.parse(await readRequestBody(req, 1024)).access, this.token);
        } catch {
          /* Invalid credentials or request bodies get the same response. */
        }
      }
      if (accepted) {
        const expires = String(Math.floor(Date.now() / 1000) + 43200);
        const cookieValue = expires + '.' + this.sessionSignature(expires);
        res.setHeader(
          'Set-Cookie',
          `${this.cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=${this.basePath}/; Max-Age=43200`,
        );
        res.writeHead(204);
        res.end();
      } else this.deny(res);
      return false;
    }
    // Sandboxed HTML has an opaque origin and cannot use the workbench cookie for
    // modules/fetch. Its capability grants GET/HEAD for this frozen version only.
    const marker = route.indexOf('/preview/', this.basePath.length);
    if (marker >= 0 && ['GET', 'HEAD'].includes(req.method ?? '')) {
      const scope = route.slice(0, marker);
      const tail = route.slice(marker + '/preview/'.length);
      const match = /^([a-f0-9]{64})\/([^/]+)\/([1-9][0-9]*)\/(.*)$/.exec(tail);
      if (
        match &&
        (scope === this.basePath || scope.startsWith(this.basePath + '/r/')) &&
        equal(match[1], previewSignature(this.token, scope, match[2], match[3]))
      ) {
        req.url = `${scope}/raw/${match[2]}/${match[3]}/${match[4]}${url.search}`;
        this.authorized.add(req);
        return true;
      }
    }
    const cookie = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(this.cookieName + '='))
      ?.slice(this.cookieName.length + 1);
    if (equal(req.headers.authorization, 'Bearer ' + this.token) || this.validSession(cookie)) {
      this.authorized.add(req);
      return true;
    }
    const isEntry = route === '/' || route === this.basePath || route === this.basePath + '/';
    if (req.method === 'GET' && isEntry) {
      const nonce = randomBytes(16).toString('base64');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(entryPage(this.basePath + '/api/access', nonce));
    } else this.deny(res);
    return false;
  }
  private deny(res: ServerResponse) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        error:
          'Open the latest complete workbench link from your CLI. 工作台需要验证，请打开 CLI 最新输出的完整链接。',
      }),
    );
  }
}

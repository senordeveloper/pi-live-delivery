/**
 * Session-scoped HTTP API, workbench assets, and frozen version previews.
 * Routes live under /live-delivery by default. Mutations require a
 * same-origin JSON request and the session's request token. Task creation and
 * workspace selection are handled by WorkbenchHost.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { currentState, ownedStates } from '../delivery/core.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { listVersionFiles, readState, resolveInsideDir, versionDir } from '../delivery/state.js';
import { UI_ASSETS } from '../ui-assets.generated.js';
import { buildReadModel } from './read-model.js';
import { queueFeedback, changeSettings, requestWrapUp } from '../delivery/controls.js';
import { readRequestBody } from './request-body.js';
import { archiveName, buildStoredZip, type ZipEntry } from './zip.js';
import type { CdConfig } from './config.js';
import { WorkbenchAccess } from './access.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Assets a self-contained HTML deliverable (e.g. a game) may load relatively:
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
};

function send(
  res: ServerResponse,
  code: number,
  body: string | Buffer,
  type = 'text/html; charset=utf-8',
): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

const PREVIEW_PAGE = (title: string, inner: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>
:root{--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--soft:#f5f5f7;--hair:rgba(0,0,0,.1);--link:#0071e3}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--bg:#1c1c1e;--muted:#a1a1a6;--soft:#2c2c2e;--hair:rgba(255,255,255,.14);--link:#0a84ff}}
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  max-width:720px;margin:0 auto;padding:40px 28px;color:var(--fg);background:var(--bg);letter-spacing:-.006em}
h1,h2,h3{line-height:1.15;letter-spacing:-.02em;margin:1.4em 0 .5em}
h1{font-size:2em;font-weight:680}h2{font-size:1.4em;font-weight:640}h3{font-size:1.15em;font-weight:600}
p,li{color:var(--fg)} a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code{background:var(--soft);padding:2px 6px;border-radius:6px;font-size:.9em}
pre{white-space:pre-wrap;word-wrap:break-word;background:var(--soft);padding:16px;border-radius:12px;border:1px solid var(--hair)}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--hair);color:var(--muted)}
hr{border:0;border-top:1px solid var(--hair);margin:1.6em 0}
table{border-collapse:collapse}td,th{border:1px solid var(--hair);padding:6px 10px}
</style><title>${escapeHtml(title)}</title>${inner}`;

function artifactHeaders(res: ServerResponse, ext: string, view: boolean) {
  // Opaque document origin even when the user opens raw HTML outside the iframe.
  if (view || ['.html', '.htm', '.svg'].includes(ext))
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-downloads');
  // Module scripts / fonts loaded by sandboxed documents have a null origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

/**
 * Serve ANY file inside a frozen version by its real relative path (path-based,
 * NOT query-based). This is what makes multi-file HTML deliverables — a game
 * with `<script src="game.js">`, images, CSS, wasm — actually work in the
 * preview iframe: the browser resolves those relative URLs against
 * `…/raw/<id>/<v>/index.html` and re-requests them here, so JS runs and assets
 * load. Path-traversal is blocked by resolveInsideDir.
 */
function serveVersionRaw(
  cfg: CdConfig,
  res: ServerResponse,
  id: string,
  version: number,
  relpath: string,
  view: boolean,
): void {
  const root = versionDir(cfg.workspaceDir, id, version);
  let abs = relpath ? resolveInsideDir(root, relpath) : root;
  if (abs && existsSync(abs) && statSync(abs).isDirectory()) {
    if (relpath && !relpath.endsWith('/')) {
      // Relative redirect retains the signed preview capability in the browser URL.
      redirect(res, './' + encodeURIComponent(path.posix.basename(relpath)) + '/');
      return;
    }
    const artifact = readState(cfg.workspaceDir, id)?.publishes.find(
      (p) => p.version === version,
    )?.artifact;
    const entry = artifact?.previewEntry;
    const entryPath = entry ? resolveInsideDir(root, entry) : null;
    const candidates = [
      ...(entryPath && (path.dirname(entryPath) === abs || abs === root) ? [entryPath] : []),
      path.join(abs, 'index.html'),
      path.join(abs, 'index.htm'),
    ];
    const target = candidates.find((p) => existsSync(p) && statSync(p).isFile());
    if (target) {
      // Redirect to the file, so its own JS/CSS relative URLs use the right directory.
      const relative = path.relative(abs, target).split(path.sep).map(encodeURIComponent).join('/');
      redirect(res, './' + relative);
      return;
    }
    abs = null;
  }
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
    send(res, 404, 'not found', 'text/plain');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  artifactHeaders(res, ext, view);
  try {
    if (view && (ext === '.md' || ext === '.markdown')) {
      send(res, 200, PREVIEW_PAGE(path.basename(abs), renderMarkdown(readFileSync(abs, 'utf8'))));
      return;
    }
    if (view && (ext === '.txt' || ext === '.csv' || ext === '.json')) {
      send(
        res,
        200,
        PREVIEW_PAGE(path.basename(abs), `<pre>${escapeHtml(readFileSync(abs, 'utf8'))}</pre>`),
      );
      return;
    }
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(readFileSync(abs));
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

/** Bundle all files of one frozen version into a STORED zip and stream it. */
function serveVersionZip(cfg: CdConfig, res: ServerResponse, id: string, version: number): void {
  const files = listVersionFiles(cfg.workspaceDir, id, version);
  if (!files.length) {
    send(res, 404, 'no files', 'text/plain');
    return;
  }
  try {
    const entries: ZipEntry[] = [];
    const state = readState(cfg.workspaceDir, id);
    const expected = state?.publishes.find((p) => p.version === version)?.artifact?.files;
    if (
      expected &&
      (expected.length !== files.length ||
        expected.some((f) => !files.some((actual) => actual.relPath === f.path)))
    )
      throw new Error('Snapshot is incomplete.');
    for (const f of files) {
      const data = readFileSync(f.absPath),
        manifest = expected?.find((item) => item.path === f.relPath);
      if (
        manifest &&
        (data.length !== manifest.bytes ||
          createHash('sha256').update(data).digest('hex') !== manifest.sha256)
      )
        throw new Error('Snapshot integrity mismatch.');
      entries.push({ name: f.relPath, data });
    }
    const zip = buildStoredZip(entries);
    const name = archiveName(`${state?.name ?? id}-v${version}`);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    res.end(zip);
  } catch {
    send(res, 500, 'zip failed', 'text/plain');
  }
}

/**
 * Build the HTTP server for a config. Call .listen() separately.
 */
export function createDeliveryServer(
  initial: CdConfig,
  options: {
    csrfToken?: string;
    stateExtras?: (model: ReturnType<typeof buildReadModel>) => Record<string, unknown>;
    access?: WorkbenchAccess;
    resolveConfig?: () => CdConfig;
  } = {},
): Server {
  const base = initial.basePath;
  const access = options.access ?? new WorkbenchAccess(base);
  initial.accessToken = access.token;
  const csrfToken = options.csrfToken ?? randomBytes(32).toString('hex');
  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        send(res, 500, 'internal error', 'text/plain');
      } catch {
        /* already sent */
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const local = req.socket.localAddress?.replace(/^::ffff:/, '');
    let requestOrigin: string;
    try {
      const host = new URL(`http://${req.headers.host}`);
      if (!['127.0.0.1', 'localhost', '[::1]', local].includes(host.hostname)) {
        send(res, 403, 'Unrecognized Host', 'text/plain');
        return;
      }
      requestOrigin = host.origin;
    } catch {
      send(res, 400, 'Invalid Host', 'text/plain');
      return;
    }
    if (!(await access.check(req, res, requestOrigin))) return;
    const cfg = options.resolveConfig ? options.resolveConfig() : initial;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
    let route = url.pathname;
    if (route === base) route = `${base}/`;
    if (!route.startsWith(`${base}/`) && route !== '/') {
      // Anything outside our base path: bounce to the index.
      redirect(res, `${base}/`);
      return;
    }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== requestOrigin) {
        send(res, 403, 'Cross-origin request rejected', 'text/plain');
        return;
      }
    }
    const rel = route === '/' ? '/' : route.slice(base.length);

    if (req.method === 'GET' && rel === '/api/state') {
      const states = ownedStates(cfg),
        requested = url.searchParams.get('s');
      const state = requested
        ? (states.find((s) => s.id === requested) ?? null)
        : (currentState(cfg) ?? states.sort((a, b) => b.startedTs - a.startedTs)[0] ?? null);
      if (requested && !state) {
        send(
          res,
          404,
          JSON.stringify({ ok: false, error: 'Task not found in this CLI session.' }),
          'application/json',
        );
        return;
      }
      const model = buildReadModel(cfg, state, csrfToken, now);
      send(
        res,
        200,
        JSON.stringify({
          ...model,
          ...options.stateExtras?.(model),
        }),
        'application/json; charset=utf-8',
      );
      return;
    }
    if (req.method === 'POST' && rel.startsWith('/api/')) {
      if (cfg.readOnly) {
        send(
          res,
          409,
          JSON.stringify({
            ok: false,
            error: 'Read-only viewer; launch the task from Codex to execute.',
          }),
          'application/json',
        );
        return;
      }
      if (
        req.headers.origin !== requestOrigin ||
        req.headers['x-cd-token'] !== csrfToken ||
        !req.headers['content-type']?.startsWith('application/json')
      ) {
        send(
          res,
          403,
          JSON.stringify({ ok: false, error: 'Invalid origin or request token.' }),
          'application/json',
        );
        return;
      }
      try {
        const data = JSON.parse(await readRequestBody(req));
        const id = z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
          .parse(data.session_id);
        if (rel === '/api/feedback') {
          const input = z
            .object({
              id: z.string().min(8).max(128),
              text: z.string().trim().min(1).max(10000),
              version: z.number().int().positive().optional(),
            })
            .parse(data);
          const receipt = queueFeedback(cfg, id, input);
          send(res, 200, JSON.stringify({ ok: true, receipt }), 'application/json');
          return;
        }
        if (rel === '/api/settings') {
          const input = z
            .object({
              timeBudgetSec: z.number().int().min(1).max(604800),
              revision: z.number().int().positive(),
            })
            .parse(data);
          changeSettings(cfg, id, input);
          send(res, 200, JSON.stringify({ ok: true }), 'application/json');
          return;
        }
        if (rel === '/api/wrap-up') {
          requestWrapUp(cfg, id);
          send(res, 200, JSON.stringify({ ok: true }), 'application/json');
          return;
        }
        send(
          res,
          404,
          JSON.stringify({ ok: false, error: 'Unknown control.' }),
          'application/json',
        );
        return;
      } catch (error) {
        send(
          res,
          409,
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
          'application/json',
        );
        return;
      }
    }
    if (req.method === 'POST') {
      send(res, 410, 'Use the authenticated workbench controls.', 'text/plain');
      return;
    }

    // --- GET /raw/<id>/<version>/<relpath...> : path-based static serve ---
    // (relative asset/JS/CSS references inside an HTML deliverable resolve here)
    if (req.method === 'GET' && rel.startsWith('/raw/')) {
      const seg = rel.slice('/raw/'.length).split('/');
      const id = decodeURIComponent(seg.shift() ?? '');
      const version = Number(seg.shift() ?? '0');
      const relpath = seg.map((s) => decodeURIComponent(s)).join('/');
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !ownedStates(cfg).some((s) => s.id === id && s.publishes.some((p) => p.version === version))
      ) {
        send(res, 400, 'bad request', 'text/plain');
        return;
      }
      if (url.searchParams.get('download') === '1')
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(relpath))}`,
        );
      serveVersionRaw(cfg, res, id, version, relpath, url.searchParams.get('view') === '1');
      return;
    }

    // --- GET /zip/<id>/<version> : download all files of a version ---
    if (req.method === 'GET' && rel.startsWith('/zip/')) {
      const seg = rel.slice('/zip/'.length).split('/');
      const id = decodeURIComponent(seg.shift() ?? '');
      const version = Number(seg.shift() ?? '0');
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !ownedStates(cfg).some((s) => s.id === id && s.publishes.some((p) => p.version === version))
      ) {
        send(res, 400, 'bad request', 'text/plain');
        return;
      }
      serveVersionZip(cfg, res, id, version);
      return;
    }

    if (req.method === 'GET') {
      // Trailing slash keeps relative UI assets correct with the base path and ?s=id.
      if (url.pathname === base || route === '/') {
        redirect(res, `${base}/${url.search}`);
        return;
      }
      const asset = UI_ASSETS[rel === '/' || rel === '' ? 'index.html' : rel.replace(/^\//, '')];
      if (asset) {
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        send(res, 200, Buffer.from(asset.body, 'base64'), asset.type);
        return;
      }
    }

    send(res, 404, 'not found', 'text/plain');
  }
}

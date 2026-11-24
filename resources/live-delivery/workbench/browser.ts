import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { atomicJson } from '../shared/json.js';
import type { CdConfig } from './config.js';
import { currentState } from '../delivery/core.js';
import { accessLink } from './access.js';
import { cdRootDir } from '../delivery/state.js';

export function sessionUrl(cfg: CdConfig, id: string): string {
  return accessLink(
    `http://127.0.0.1:${cfg.port}${cfg.basePath}/?s=${encodeURIComponent(id)}`,
    cfg.accessToken,
  );
}

export function deliveryLinks(
  cfg: Pick<CdConfig, 'port' | 'basePath' | 'bindHost' | 'accessToken' | 'dashboardFile'>,
  id?: string,
): string[] {
  if (cfg.dashboardFile) {
    try {
      const record = JSON.parse(readFileSync(cfg.dashboardFile, 'utf8'));
      if (
        (id !== undefined && record.sessionId !== id) ||
        !Array.isArray(record.urls) ||
        !record.urls.length
      )
        return [];
      return record.urls.filter((value: unknown): value is string => {
        if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            url.searchParams.get('s') === record.sessionId
          );
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
  const suffix = `${cfg.basePath}/${id ? '?s=' + encodeURIComponent(id) : ''}`;
  const local = `http://127.0.0.1:${cfg.port}${suffix}`;
  if (cfg.bindHost === '127.0.0.1') return [accessLink(local, cfg.accessToken)];
  const addresses = [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((items) =>
        (items ?? [])
          .filter((item) => item.family === 'IPv4' && !item.internal)
          .map((item) => item.address),
      ),
    ),
  ];
  return [local, ...addresses.map((address) => `http://${address}:${cfg.port}${suffix}`)].map(
    (url) => accessLink(url, cfg.accessToken),
  );
}

/** Plain text for native hook notices; Markdown for model-visible tool replies. */
export function dashboardFooter(cfg: CdConfig, id: string, markdown = false): string {
  const title = '👉 持续交付工作台 / DELIVERY DASHBOARD';
  const links = deliveryLinks(cfg, id);
  return [
    markdown ? `**${title}**` : title,
    ...(links.length
      ? [`Page: ${links[0]}`]
      : [
          'Workbench link unavailable. Reopen the current parent workbench link; do not guess a URL.',
        ]),
    ...links.slice(1).map((url) => `服务器 / Server: ${url}`),
  ].join('\n');
}

export function shouldOpenBrowser(mode: string, platform: string, env: NodeJS.ProcessEnv): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CI) return false;
  return platform === 'darwin' || (platform === 'linux' && !!(env.DISPLAY || env.WAYLAND_DISPLAY));
}
export function openDeliveryOnce(cfg: CdConfig, log: (message: string) => void): void {
  const state = currentState(cfg);
  if (!state || cfg.readOnly) return;
  const marker = path.join(cdRootDir(cfg.workspaceDir), '_runtime', `browser-${state.id}.json`);
  if (existsSync(marker)) return;
  const url = deliveryLinks(cfg, state.id)[0];
  if (!url) {
    log('Workbench link unavailable; use the parent workbench entry.');
    return;
  }
  const attempt = shouldOpenBrowser(cfg.openBrowser ?? 'auto', process.platform, process.env);
  atomicJson(marker, { ts: Date.now(), attempt, url });
  log(`Delivery page: ${url}`);
  const footer = () => log(dashboardFooter(cfg, state.id));
  log(
    state.requirePlanApproval
      ? '打开工作台确认首版计划，或在 CLI 同意；随后查看成果和追加要求。Open the dashboard to approve the first plan, or approve in CLI; then preview deliveries and send feedback.'
      : '打开工作台查看计划和成果；可随时追加要求或停止任务。Open the dashboard to review the plan and deliveries, send feedback, or stop the task.',
  );
  if (!attempt) {
    const entry = new URL(url);
    const port = entry.port || (entry.protocol === 'https:' ? '443' : '80');
    log(
      `Browser auto-open skipped. For SSH, forward port ${port} to your computer and open the URL there.`,
    );
    footer();
    return;
  }
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) {
    log('Browser auto-open unavailable on this platform; open the printed URL.');
    footer();
    return;
  }
  const env = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
  );
  const child = spawn(command, [url], { env, stdio: 'ignore', detached: true });
  child.on('error', () => {
    log('Could not open the browser; open the printed URL.');
    footer();
  });
  const timeout = setTimeout(() => {
    child.kill();
    log('Browser opener timed out; open the printed URL.');
    footer();
  }, 3000);
  timeout.unref();
  child.on('exit', (code) => {
    clearTimeout(timeout);
    if (code) {
      log('Browser opener failed; open the printed URL.');
      footer();
    }
  });
  child.unref();
  footer();
}

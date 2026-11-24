import { readdirSync, type Dirent } from 'node:fs';
import nodePath from 'node:path';
import { collectFileEntries, resolveDeliverable, STATE_ROOT_DIRNAME } from './state.js';
/** Max file names echoed back in a ld_publish result. */
const MAX_ECHOED_FILES = 25;

/** Format a file size for tool output. */
function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * List the files covered by publication paths, including missing paths, so the
 * Agent can check the delivered contents before describing the version.
 */
export function fileListing(
  workspaceDir: string,
  relPaths: string[],
): { text: string; nFiles: number; nMissing: number; totalBytes: number } {
  const entries = collectFileEntries(workspaceDir, relPaths);
  const present = entries.filter((e) => !e.missing);
  const missing = entries.filter((e) => e.missing);
  const totalBytes = present.reduce((sum, e) => sum + e.size, 0);
  const lines = entries.slice(0, MAX_ECHOED_FILES).map(
    (e) =>
      `  - ${e.relPath}${e.missing ? '   ⚠ NOT ON DISK' : ` (${bytesLabel(e.size)})`}` +
      // Show the canonical path for subsequent tool calls.
      (e.rewrittenFrom ? `   ← resolved from "${e.rewrittenFrom}"` : ''),
  );
  if (entries.length > MAX_ECHOED_FILES) {
    lines.push(`  - … and ${entries.length - MAX_ECHOED_FILES} more file(s)`);
  }
  const head =
    `${present.length} file(s), ${bytesLabel(totalBytes)}` +
    (missing.length ? `, ${missing.length} MISSING` : '') +
    ` (from ${relPaths.length} path(s))`;
  return {
    text: lines.length ? `${head}:\n${lines.join('\n')}` : head,
    nFiles: present.length,
    nMissing: missing.length,
    totalBytes,
  };
}

/**
 * Suggest a workspace-relative path when a supplied path cannot be resolved.
 * Order: (1) treat it as absolute and strip leading segments until the remainder
 * exists under the root; (2) fall back to a bounded search for the basename.
 * Returns a workspace-relative path, or undefined when the file truly is absent.
 */
export function suggestRelative(workspaceDir: string, given: string): string | undefined {
  const direct = resolveDeliverable(workspaceDir, given);
  if (direct) {
    return direct.rel;
  }
  const base = given.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  if (!base) {
    return undefined;
  }
  const root = nodePath.resolve(workspaceDir);
  const SKIP = new Set([STATE_ROOT_DIRNAME, '.git', 'node_modules', 'documents']);
  const MAX_DIRS = 400;
  let seen = 0;
  const queue: Array<{ dir: string; rel: string; depth: number }> = [
    { dir: root, rel: '', depth: 0 },
  ];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || cur.depth > 3 || seen++ > MAX_DIRS) {
      continue;
    }
    let items: Dirent[];
    try {
      items = readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const rel = cur.rel ? `${cur.rel}/${it.name}` : it.name;
      if (it.isFile() && it.name === base) {
        return rel;
      }
      if (it.isDirectory() && !SKIP.has(it.name) && !it.name.startsWith('.')) {
        queue.push({ dir: nodePath.join(cur.dir, it.name), rel, depth: cur.depth + 1 });
      }
    }
  }
  return undefined;
}

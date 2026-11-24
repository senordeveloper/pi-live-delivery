/**
 * Persistence for CD release state under `<workspaceDir>/.live-delivery/`.
 *
 * Writes use a temporary file and rename so readers see complete state files.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { CdFileEntry, CdReleaseState } from './types.js';

export const STATE_ROOT_DIRNAME = '.live-delivery';
export const QWEN_LD_PROTOCOL = 'v1';
const STATE_FILENAME = 'release.json';

/** Root `.live-delivery` directory for a workspace. */
export function cdRootDir(workspaceDir: string): string {
  return path.join(workspaceDir, STATE_ROOT_DIRNAME);
}

/**
 * Per-session state directory, keyed by its filesystem-safe id. Attaching with
 * `ld_begin` reuses the active session; an explicit new task gets a new id.
 */
export function sessionDir(workspaceDir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === '.' || id === '..')
    throw new Error('Invalid CD session id');
  return path.join(cdRootDir(workspaceDir), id);
}

/** Absolute path of the release.json for a session id. */
export function stateFilePath(workspaceDir: string, id: string): string {
  return path.join(sessionDir(workspaceDir, id), STATE_FILENAME);
}

// The active-session index maps a host session key → the CD session id it
// is currently driving. `ld_begin` writes it; tools/keep-working resolve "the
// CD session I'm working on now" from it.
const ACTIVE_INDEX_FILENAME = '_active.json';

/** Mint a filesystem-safe, unique CD session id from a human name. */
export function makeSessionId(name: string): string {
  const src = name || 'cd';
  const base = src
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const rand = createHash('sha256')
    .update(`${name}:${process.pid}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  // For non-latin names (e.g. Chinese), stripping non-ASCII can leave a
  // misleading fragment (e.g. a 拳皇 task → "html-20" because those were the
  // only latin chars). If the slug keeps too little of the source, use a neutral
  // "cd" prefix instead of a misleading one — the human-readable NAME (which may
  // be non-latin) is stored separately and shown in the UI.
  const asciiRatio = base.replace(/-/g, '').length / Math.max(1, src.trim().length);
  const usable = base && asciiRatio >= 0.4 ? base : 'cd';
  return `${usable}-${rand}`;
}

/** The active CD session id for a host session key (or null). */
export function getActiveId(workspaceDir: string, sessionKey: string): string | null {
  try {
    const file = path.join(cdRootDir(workspaceDir), ACTIVE_INDEX_FILENAME);
    const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    return map?.[sessionKey] ?? null;
  } catch {
    return null;
  }
}

/** Point a host session key at the CD session id it is now driving. */
export function setActiveId(workspaceDir: string, sessionKey: string, id: string): void {
  const dir = cdRootDir(workspaceDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ACTIVE_INDEX_FILENAME);
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    map = {};
  }
  map[sessionKey] = id;
  const tmp = path.join(dir, `.${ACTIVE_INDEX_FILENAME}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  renameSync(tmp, file);
}

const VERSIONS_DIRNAME = 'versions';

/** Directory holding immutable per-version snapshots for a session. */
export function versionDir(workspaceDir: string, sessionKey: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid CD version');
  return path.join(sessionDir(workspaceDir, sessionKey), VERSIONS_DIRNAME, `v${version}`);
}

/** List a frozen version's files as {relPath, absPath, size} (empty if none). */
export function listVersionFiles(
  workspaceDir: string,
  sessionKey: string,
  version: number,
): Array<{ relPath: string; absPath: string; size: number }> {
  const root = versionDir(workspaceDir, sessionKey, version);
  if (!existsSync(root)) {
    return [];
  }
  const entries: CdFileEntry[] = [];
  walkDir(root, '', entries, 0);
  return entries
    .filter((e) => !e.missing)
    .map((e) => ({ relPath: e.relPath, absPath: path.join(root, e.relPath), size: e.size }));
}

/** Path-traversal guard for an arbitrary base directory (returns abs or null). */
export function resolveInsideDir(baseDir: string, rel: string): string | null {
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  if (!underRoot(realOrSelf(root), realOrSelf(resolved))) return null;
  return resolved;
}

/** Read state for a session, or `null` when absent/corrupt. */
export function readState(workspaceDir: string, id: string): CdReleaseState | null {
  const file = stateFilePath(workspaceDir, id);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as CdReleaseState;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.stateVersion === 1 &&
      parsed.protocol === QWEN_LD_PROTOCOL &&
      parsed.id === id &&
      typeof parsed.name === 'string' &&
      parsed.name.trim()
    ) {
      return parsed;
    }
    return null;
  } catch {
    // Corrupt or partially written file: treat as absent rather than crash.
    return null;
  }
}

/** Atomically write state for a session. */
export function writeState(workspaceDir: string, state: CdReleaseState): void {
  const dir = sessionDir(workspaceDir, state.id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STATE_FILENAME);
  const tmp = path.join(dir, `.${STATE_FILENAME}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);
}

/** List every persisted CD session state in a workspace. */
export function listStates(workspaceDir: string): CdReleaseState[] {
  const root = cdRootDir(workspaceDir);
  if (!existsSync(root)) {
    return [];
  }
  const out: CdReleaseState[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const state = readState(workspaceDir, entry.name);
      if (state) out.push(state);
    } catch {
      // Skip unreadable session dirs.
    }
  }
  return out;
}

/** Guard against pathological / symlink-looped trees. */
const MAX_WALK_DEPTH = 32;

/**
 * Recursively walk a directory, pushing a {@link CdFileEntry} for every regular
 * file underneath it. `relPrefix` is the workspace-relative path of `absDir`.
 * Symlinks are not followed (we only descend real directories) to avoid loops
 * and workspace escapes.
 */
function walkDir(absDir: string, relPrefix: string, out: CdFileEntry[], depth: number): void {
  if (depth > MAX_WALK_DEPTH) {
    return;
  }
  let children: Dirent[];
  try {
    children = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const childRel = path.posix.join(relPrefix, child.name);
    const childAbs = path.join(absDir, child.name);
    if (child.isDirectory()) {
      walkDir(childAbs, childRel, out, depth + 1);
    } else if (child.isFile()) {
      try {
        const st = statSync(childAbs);
        out.push({
          relPath: childRel,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          missing: false,
        });
      } catch {
        out.push({ relPath: childRel, size: 0, mtimeMs: 0, missing: true });
      }
    }
  }
}

/**
 * Resolve, stat, and (recursively for directories) expand a set of
 * workspace-relative paths into file descriptors used for digesting/listing.
 *
 */
export function collectFileEntries(workspaceDir: string, relPaths: string[]): CdFileEntry[] {
  const entries: CdFileEntry[] = [];
  for (const given of relPaths) {
    // Store canonical relative paths even when the input uses a workspace alias.
    const r = resolveDeliverable(workspaceDir, given);
    if (!r) {
      entries.push({ relPath: given, size: 0, mtimeMs: 0, missing: true });
      continue;
    }
    try {
      const st = statSync(r.abs);
      if (st.isDirectory()) {
        walkDir(r.abs, r.rel, entries, 0);
      } else {
        entries.push({
          relPath: r.rel,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          missing: false,
          ...(r.rewrittenFrom ? { rewrittenFrom: r.rewrittenFrom } : {}),
        });
      }
    } catch {
      entries.push({ relPath: given, size: 0, mtimeMs: 0, missing: true });
    }
  }
  return entries;
}

/**
 * Resolve a deliverable path given by the agent into an absolute path inside the
 * workspace, plus the canonical workspace-RELATIVE form to store in state.
 *
 * Listings accept relative paths, absolute paths under the root, and workspace
 * aliases. Unmatched leading segments may resolve by an existing suffix under
 * the workspace; report that rewrite to the caller.
 * Publication uses the stricter resolvePublishedPath, without suffix recovery.
 */
export type ResolvedDeliverable = {
  /** Absolute path on disk. */
  abs: string;
  /** Canonical workspace-relative path (POSIX separators) to store in state. */
  rel: string;
  /** Set when the input was rewritten (absolute -> relative, or suffix rescue). */
  rewrittenFrom?: string;
};

function underRoot(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function resolveDeliverable(
  workspaceDir: string,
  given: string,
): ResolvedDeliverable | null {
  const root = path.resolve(workspaceDir);
  const raw = given.replace(/\\/g, '/').trim();
  if (!raw || raw.split('/').includes('..')) {
    return null;
  }
  const toRel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');

  // 1 + 2: plain lexical resolution (relative, or absolute already under root).
  const lexical = path.resolve(root, raw);
  if (underRoot(root, lexical)) {
    if (!underRoot(realOrSelf(root), realOrSelf(lexical))) return null;
    return {
      abs: lexical,
      rel: toRel(lexical),
      ...(path.isAbsolute(raw) ? { rewrittenFrom: given } : {}),
    };
  }

  // Everything below only applies to absolute paths pointing outside the root.
  // 3: same file reached through a different alias (symlink / bind mount).
  const realRoot = realOrSelf(root);
  const realGiven = realOrSelf(lexical);
  if (underRoot(realRoot, realGiven)) {
    const rel = path.relative(realRoot, realGiven).split(path.sep).join('/');
    return { abs: path.join(root, rel), rel, rewrittenFrom: given };
  }

  // 4: suffix rescue — drop leading segments until the remainder exists.
  const segs = raw.split('/').filter((x) => x.length > 0);
  for (let i = 1; i < segs.length; i += 1) {
    const cand = segs.slice(i).join('/');
    const abs = path.resolve(root, cand);
    if (!underRoot(root, abs) || !underRoot(realRoot, realOrSelf(abs))) {
      continue;
    }
    try {
      statSync(abs);
      return { abs, rel: toRel(abs), rewrittenFrom: given };
    } catch {
      /* keep stripping */
    }
  }
  return null;
}

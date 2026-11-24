import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { STATE_ROOT_DIRNAME, versionDir } from './state.js';
import type { CdArtifact } from './types.js';

const PRIVATE_PARTS = new Set([
  STATE_ROOT_DIRNAME,
  '.git',
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.npmrc',
  '.netrc',
  'auth.json',
  'credentials.json',
  'node_modules',
]);
function privatePath(rel: string): boolean {
  return rel
    .split('/')
    .some(
      (part) =>
        PRIVATE_PARTS.has(part.toLowerCase()) ||
        /^\.env(?:\.|$)/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}
function inside(root: string, file: string) {
  return file === root || file.startsWith(root + path.sep);
}
export function resolvePublishedPath(
  workspace: string,
  given: string,
): { abs: string; rel: string } | null {
  if (!given.trim() || given.includes('\0') || given.replace(/\\/g, '/').split('/').includes('..'))
    return null;
  try {
    const root = realpathSync(workspace),
      abs = realpathSync(path.resolve(workspace, given));
    if (!inside(root, abs)) return null;
    return { abs, rel: path.relative(root, abs).split(path.sep).join('/') };
  } catch {
    return null;
  }
}

function fileHash(file: string): string {
  const fd = openSync(file, 'r'),
    hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(128 * 1024);
  try {
    let n;
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** All-or-nothing snapshot. No state/version counter changes until this succeeds. */
export function preparePublication(
  workspace: string,
  id: string,
  version: number,
  inputs: string[],
  preview?: string,
) {
  const root = realpathSync(workspace);
  const excluded = new Set<string>(),
    paths = new Set<string>();
  const sources = new Map<
    string,
    { abs: string; size: number; mtimeMs: number; ctimeMs: number; ino: number }
  >();
  const missing: string[] = [];
  let totalBytes = 0;
  function walk(abs: string, rel: string, depth: number) {
    if (privatePath(rel)) {
      excluded.add(rel);
      return;
    }
    if (depth > 32) throw new Error(`Publication nesting exceeds 32 levels: ${rel}`);
    const st = lstatSync(abs);
    if (st.isSymbolicLink())
      throw new Error(`Symlink inside deliverable; publish real files instead: ${rel}`);
    if (!inside(root, realpathSync(abs))) throw new Error(`File escaped the workspace: ${rel}`);
    if (st.isDirectory()) {
      for (const child of readdirSync(abs).sort())
        walk(path.join(abs, child), path.posix.join(rel, child), depth + 1);
    } else if (st.isFile()) {
      if (sources.has(rel)) return;
      totalBytes += st.size;
      if (sources.size >= 20000 || totalBytes > 2 * 1024 ** 3)
        throw new Error(
          'Publication exceeds 20,000 files or 2 GiB. Select a smaller complete deliverable directory.',
        );
      sources.set(rel, {
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        ino: st.ino,
      });
    } else throw new Error(`Only regular files and directories can be published: ${rel}`);
  }
  for (const input of inputs) {
    const resolved = resolvePublishedPath(workspace, input);
    if (!resolved) {
      missing.push(input);
      continue;
    }
    if (privatePath(resolved.rel))
      throw new Error(`Private/runtime path cannot be published: ${input}`);
    paths.add(resolved.rel || '.');
    walk(resolved.abs, resolved.rel, 0);
  }
  if (!sources.size) throw new Error('no_files_resolved');
  if (missing.length)
    throw new Error(
      `Some requested paths are missing or outside the workspace; no version created: ${missing.join(', ')}`,
    );

  let previewEntry: string | undefined;
  if (preview) {
    const resolved = resolvePublishedPath(workspace, preview);
    if (!resolved)
      throw new Error(
        'preview_entry must be an existing file or index directory inside the workspace.',
      );
    const candidates = statSync(resolved.abs).isDirectory()
      ? ['index.html', 'index.htm'].map((name) => path.posix.join(resolved.rel, name))
      : [resolved.rel];
    previewEntry = candidates.find((rel) => sources.has(rel));
    if (!previewEntry)
      throw new Error(
        'preview_entry is not included in paths. Publish its whole directory and dependencies; for a directory, include index.html or index.htm.',
      );
  } else {
    const preferred = [...paths]
      .flatMap((rel) =>
        ['index.html', 'index.htm'].map((name) => path.posix.join(rel === '.' ? '' : rel, name)),
      )
      .filter((rel) => sources.has(rel));
    const available = [...sources.keys()].filter((rel) =>
      /\.(html?|md|markdown|txt|pdf|png|jpe?g|webp|svg)$/i.test(rel),
    );
    previewEntry =
      preferred.length === 1 ? preferred[0] : available.length === 1 ? available[0] : undefined;
  }
  const destination = versionDir(workspace, id, version);
  const candidate = path.join(path.dirname(destination), `.candidate-${version}-${randomUUID()}`);
  const files: NonNullable<CdArtifact['files']> = [];
  try {
    for (const [rel, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
      const target = path.join(candidate, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      if (!inside(root, realpathSync(source.abs)))
        throw new Error(`File escaped the workspace: ${rel}`);
      copyFileSync(source.abs, target);
      const bytes = statSync(target).size;
      if (bytes !== source.size) throw new Error(`File changed while publishing: ${rel}`);
      files.push({ path: rel, bytes, sha256: fileHash(target) });
    }
    for (const [rel, source] of sources) {
      const after = lstatSync(source.abs);
      if (
        !after.isFile() ||
        after.size !== source.size ||
        after.mtimeMs !== source.mtimeMs ||
        after.ctimeMs !== source.ctimeMs ||
        after.ino !== source.ino
      )
        throw new Error(`File changed while publishing; retry once writes finish: ${rel}`);
    }
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    return {
      files,
      digest,
      paths: [...paths],
      previewEntry,
      excluded: [...excluded],
      totalBytes,
      commit() {
        // An unreferenced directory can remain after a crash between rename and
        // state commit. The caller only chooses the next unrecorded version.
        if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
        renameSync(candidate, destination);
      },
      discard() {
        rmSync(candidate, { recursive: true, force: true });
      },
      rollback() {
        rmSync(destination, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    throw error;
  }
}

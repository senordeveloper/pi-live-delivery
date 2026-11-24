import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { cdRootDir } from './state.js';

const EMPTY_LOCK_GRACE_MS = 30_000;

function recoverLock(lock: string): boolean {
  try {
    const pid = Number(readFileSync(path.join(lock, 'pid'), 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          rmSync(lock, { recursive: true, force: true });
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    const before = statSync(lock);
    if (Date.now() - before.mtimeMs < EMPTY_LOCK_GRACE_MS || readdirSync(lock).length !== 0)
      return false;
    const current = statSync(lock);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mtimeMs !== before.mtimeMs
    )
      return false;
    // Atomic empty-directory removal cannot delete an owner that just wrote its PID.
    rmdirSync(lock);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

// Shared by MCP and hooks, including recovery of a process that exited before
// recording its PID. A live owner's lock never expires by age alone.
export function withLock<T>(workspace: string, fn: () => T): T {
  const root = cdRootDir(workspace);
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, '_write.lock');
  const until = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (recoverLock(lock)) continue;
      if (Date.now() >= until) throw new Error(`CD state is busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeFileSync(path.join(lock, 'pid'), String(process.pid));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

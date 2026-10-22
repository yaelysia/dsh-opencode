import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(id);
const filename = id => createHash('sha256').update(id).digest('hex') + '.json';
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // Unknown owner: never delete.
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Minimal owned-session journal, not a second conversation store.
 * Files contain only opaque OpenCode IDs and process leases; never message text.
 * Never delete sessions from other live DSH processes or unknown owners. */
export class SessionJournal {
  constructor({ directory, removeSession, logger, onEvent, isAlive = processAlive } = {}) {
    this.directory = directory || null;
    this.removeSession = removeSession;
    this.logger = logger;
    this.onEvent = onEvent;
    this.isAlive = isAlive;
    this.instance = randomUUID();
    this.owned = new Set();
    this.pending = new Map();
    this.started = null;
    this.recovering = null;
    this.stopping = false;
  }

  file(id) { return path.join(this.directory, filename(id)); }

  async init() {
    if (!this.directory) return;
    if (this.started) return this.started;
    this.started = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const orphans = [];
      for (const name of await readdir(this.directory)) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        let record;
        try { record = JSON.parse(await readFile(path.join(this.directory, name), 'utf8')); }
        catch { continue; }
        if (record?.format !== 1 || !validId(record.id) || name !== filename(record.id)
          || typeof record.instance !== 'string') continue;
        if (record.pid === process.pid || this.isAlive(record.pid)) continue;
        orphans.push(record.id);
      }
      // Orphan deletion must never block the first user request. Two workers
      // bound backend load; unfinished journal records survive plugin shutdown.
      if (orphans.length) this.onEvent?.('orphan.detected', { count: orphans.length });
      const worker = async () => {
        while (!this.stopping && orphans.length) {
          const id = orphans.shift();
          // A shared server/auth failure can make every orphan DELETE fail.
          // Stop this startup sweep after a failure instead of hammering it.
          if (!(await this.retire(id, { force: true }))) break;
        }
      };
      this.recovering = Promise.allSettled(
        Array.from({ length: Math.min(2, orphans.length) }, worker));
    })().catch(error => {
      this.logger?.warn?.('dsh-opencode: Session journal unavailable (' +
        (error.code || 'IO') + ')');
    });
    return this.started;
  }

  async track(id) {
    if (!validId(id)) throw new TypeError('Invalid OpenCode Session identity');
    this.owned.add(id);
    this.onEvent?.('session.tracked', { source: 'owned' });
    if (!this.directory) return;
    await this.init();
    const record = JSON.stringify({ format: 1, id, pid: process.pid,
      instance: this.instance, createdAt: Date.now() });
    const tmp = this.file(id) + '.' + this.instance + '.tmp';
    try {
      await writeFile(tmp, record, { flag: 'wx', mode: 0o600 });
      await rename(tmp, this.file(id));
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn?.('dsh-opencode: cannot journal owned Session (' +
        (error.code || 'IO') + ')');
    }
  }

  /** Returns a tracked promise; concurrent retire calls are idempotent. */
  retire(id, { force = false } = {}) {
    if (!validId(id) || (!force && !this.owned.has(id))) return Promise.resolve(false);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const task = (async () => {
      try {
        await this.removeSession(id);
        this.owned.delete(id);
        if (this.directory) await rm(this.file(id), { force: true });
        this.onEvent?.('session.reclaimed', { source: force ? 'orphan' : 'owned' });
        return true;
      } catch (error) {
        // Retain the on-disk record; do not repeatedly delete in a tight loop.
        this.logger?.warn?.('dsh-opencode: owned Session cleanup deferred (' +
          (error.code || 'TRANSPORT') + ')');
        this.onEvent?.('session.reclaim-failed', { errorCode: error.code || 'TRANSPORT' }, 'warn');
        return false;
      }
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  async drain() {
    this.stopping = true;
    await this.started;
    await this.recovering;
    await Promise.allSettled([...this.pending.values()]);
  }
}

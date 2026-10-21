import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { childEnvironment, secureServerEnvironment } from './service-env.js';
import { BRIDGE_AGENT_ID, managedAgentEnvironment, requireBridgeAgent } from './managed-agent.js';
import { failure } from './errors.js';
import { bundledExecutable } from './opencode-binary.js';

const START_TIMEOUT_MS = 15_000;
const CHECK_INTERVAL_MS = 250;

/** Auto-management is restricted to the exact HTTP loopback endpoint used by the adapter. */
export function localEndpoint(endpoint) {
  const url = new URL(endpoint || 'http://127.0.0.1:4096');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash ||
      url.username || url.password) return null;
  const port = Number(url.port || '80');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  return { port, origin: 'http://127.0.0.1:' + port };
}

export function installedExecutable(config = {}, env = process.env,
  platform = process.platform, bundledOptions = {}) {
  const custom = config.opencodeExecutable || env.OPENCODE_EXECUTABLE;
  return custom ? path.resolve(custom) : bundledExecutable({ platform, ...bundledOptions });
}

async function portAvailable(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') return false;
    throw error;
  } finally {
    await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
}

/** One Cordis plugin instance owns at most one child process. */
export class OpenCodeService {
  constructor(config = {}, deps = {}) {
    this.config = config;
    this.agent = requireBridgeAgent(config.agent || BRIDGE_AGENT_ID);
    // Disabled by default until verified against the real OpenCode free tier.
    this.guardedRead = config.guardedReadCompatibility === true;
    this.logger = deps.logger || console;
    this.env = deps.env || process.env;
    this.runtimeRoot = path.resolve(config.runtimeRoot || path.join(
      this.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'OpenCodeRuntime'));
    // An unguessable local server password belongs to this plugin instance only.
    this.ownedPassword = randomBytes(32).toString('hex');
    this.platform = deps.platform || process.platform;
    this.fetchImpl = deps.fetchImpl || fetch;
    this.spawnImpl = deps.spawnImpl || spawn;
    this.accessImpl = deps.accessImpl || access;
    this.mkdirImpl = deps.mkdirImpl || mkdir;
    this.readFileImpl = deps.readFileImpl || readFile;
    this.rmImpl = deps.rmImpl || rm;
    this.portAvailableImpl = deps.portAvailableImpl || portAvailable;
    this.sleepImpl = deps.sleepImpl || sleep;
    this.argsImpl = deps.argsImpl || (port => ['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
    this.controller = new AbortController();
    this.target = localEndpoint(config.endpoint);
    if (this.guardedRead && (config.autoStart === false || !this.target)) {
      throw failure('Guarded read requires an automatically managed loopback OpenCode process',
        'GUARD_REQUIRES_MANAGED_SERVER');
    }
    if (config.autoStart !== false && !this.target) {
      this.logger.info?.('dsh-opencode: auto-start skipped for non-loopback or non-HTTP endpoint');
    }
    this.owned = null;
    this.starting = null;
    this.closed = false;
    this.readyOwned = false;
    this.guardProof = null;
    this.guardVerified = false;
  }

  async verifiedNativeDenials(parts) {
    if (!this.guardedRead || !this.guardVerified || !this.guardProof) return new Set();
    let content;
    try { content = await this.readFileImpl(this.guardProof.audit, 'utf8'); }
    catch { return new Set(); }
    if (Buffer.byteLength(content) > 1_000_000) return new Set();
    const records = new Set();
    for (const line of content.split('\n')) {
      if (!line || line.length > 1024) continue;
      try {
        const item = JSON.parse(line);
        if (item.nonce === this.guardProof.nonce
          && typeof item.callID === 'string' && typeof item.sessionID === 'string'
          && typeof item.tool === 'string') {
          records.add(JSON.stringify([item.sessionID, item.callID, item.tool]));
        }
      } catch { /* Incomplete append: never count as a denial. */ }
    }
    return new Set(parts.filter(part => part.type === 'tool' && part.state?.status === 'error'
      && typeof part.callID === 'string' && typeof part.sessionID === 'string'
      && records.has(JSON.stringify([part.sessionID, part.callID, part.tool])))
      .map(part => part.id));
  }

  async verifyGuard() {
    if (!this.guardedRead) return true;
    if (this.guardVerified) return true;
    if (!this.guardProof) return false;
    try {
      const content = await this.readFileImpl(this.guardProof.marker, 'utf8');
      this.guardVerified = content === this.guardProof.nonce;
    } catch { return false; }
    return this.guardVerified;
  }

  passwordForClient() {
    // Never inject the generated secret into an unmanaged external server.
    return this.owned ? this.ownedPassword :
      this.env[this.config.passwordEnv || 'OPENCODE_SERVER_PASSWORD'];
  }

  /** Reuse one Basic Auth header path for health and agent lookup. */
  headers() {
    const password = this.passwordForClient();
    if (!password) return {};
    const username = this.config.username || this.env.OPENCODE_SERVER_USERNAME || 'opencode';
    return { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') };
  }

  async health() {
    if (!this.target) return false;
    try {
      const response = await this.fetchImpl(this.target.origin + '/global/health', {
        method: 'GET', headers: this.headers(), redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(900)]),
      });
      if (!response.ok) return false;
      const status = await response.json();
      return status?.healthy === true && typeof status?.version === 'string';
    } catch { return false; }
  }

  /** Fail visibly if an existing OpenCode service lacks the DSH-specific agent. */
  async assertAgentPresent() {
    const agent = this.agent;
    if (!this.target) return;
    let response;
    try {
      response = await this.fetchImpl(this.target.origin + '/agent', {
        method: 'GET', headers: this.headers(), redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
      });
    } catch (error) {
      throw failure('Cannot check OpenCode agent: ' + error.message, 'SERVER_AGENT_CHECK_FAILED');
    }
    if (!response.ok) {
      throw failure('OpenCode agent lookup returned HTTP ' + response.status, 'SERVER_AGENT_CHECK_FAILED', response.status);
    }
    let agents;
    try { agents = await response.json(); } catch {}
    if (!Array.isArray(agents)) throw failure('Invalid OpenCode agent list', 'SERVER_AGENT_CHECK_FAILED');
    if (!agents.some(item => item?.name === agent)) {
      throw failure('OpenCode agent "' + agent + '" is missing. Stop the old manual opencode serve '
        + 'process and restart DSH Desktop so the plugin can start its isolated server.', 'SERVER_AGENT_MISSING');
    }
  }

  /** Called at plugin mount and before each ordinary model call. */
  async ready(options = {}) {
    if (this.closed) throw failure('OpenCode plugin is unloading', 'SERVER_STOPPED');
    if (this.config.autoStart !== false && this.target) {
      if (this.starting) await this.starting;
      else if (!(this.owned && this.owned.exitCode === null &&
        this.owned.signalCode === null && this.readyOwned)) {
        this.starting = this.ensureStarted().finally(() => { this.starting = null; });
        await this.starting;
      }
    }
    // When the DSH tool bridge is enabled, do not trust a pre-existing
    // OpenCode process whose tools/config/plugins we cannot control.
    if (options.requireManaged && !(this.owned && this.readyOwned &&
      this.owned.exitCode === null && this.owned.signalCode === null)) {
      throw failure('OpenCode tool boundary cannot be guaranteed for an external server. ' +
        'Stop the existing opencode serve and restart DSH so the plugin owns its child process.',
        'UNTRUSTED_OPENCODE_SERVER');
    }
  }

  async ensureStarted() {
    if (await this.health()) {
      await this.assertAgentPresent();
      if (!this.owned) this.logger.info?.('dsh-opencode: reusing an existing local OpenCode server');
      return;
    }
    this.controller.signal.throwIfAborted();
    const { port, origin } = this.target;
    if (!(await this.portAvailableImpl(port))) {
      throw failure('OpenCode server cannot start: ' + origin +
        ' is occupied but its health check failed', 'SERVER_PORT_BUSY');
    }
    const root = this.runtimeRoot;
    const exe = installedExecutable(this.config, this.env, this.platform);
    if (path.isAbsolute(exe)) {
      try { await this.accessImpl(exe); }
      catch { throw failure('OpenCode executable not found: ' + exe +
        '. Configure opencodeExecutable.', 'SERVER_NOT_INSTALLED'); }
    }
    if (this.guardedRead) {
      this.guardProof = {
        marker: path.join(root, 'dsh-guard-' + randomBytes(16).toString('hex') + '.ready'),
        nonce: randomBytes(32).toString('hex'),
        audit: path.join(root, 'dsh-guard-' + randomBytes(16).toString('hex') + '.jsonl'),
      };
      this.guardVerified = false;
    }
    const childEnv = secureServerEnvironment(managedAgentEnvironment(
      childEnvironment(this.env, root, this.config.autoStartDirect !== false),
      this.agent,
      root,
      { guardedRead: this.guardedRead },
    ), {
      password: this.ownedPassword,
      username: this.config.username || this.env.OPENCODE_SERVER_USERNAME || 'opencode',
      passwordEnv: this.config.passwordEnv,
    });
    if (this.guardProof) {
      childEnv.DSH_OPENCODE_GUARD_MARKER = this.guardProof.marker;
      childEnv.DSH_OPENCODE_GUARD_NONCE = this.guardProof.nonce;
      childEnv.DSH_OPENCODE_GUARD_AUDIT = this.guardProof.audit;
    }
    for (const key of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
      await this.mkdirImpl(childEnv[key], { recursive: true });
    }
    const cwd = path.join(root, 'workspace');
    await this.mkdirImpl(cwd, { recursive: true });
    this.controller.signal.throwIfAborted();
    // No shell, terminal window, system proxy changes or background model probes.
    const child = this.spawnImpl(exe, this.argsImpl(port), {
      cwd, env: childEnv, shell: false, windowsHide: true, stdio: 'ignore',
    });
    this.owned = child;
    this.readyOwned = false;
    let terminal = null;
    child.on('error', error => { terminal = 'spawn failed: ' + error.message; });
    child.on('exit', (code, signal) => { terminal = 'exited (' + (code ?? signal ?? 'unknown') + ')'; });
    try {
      const deadline = Date.now() + (this.config.autoStartTimeoutMs || START_TIMEOUT_MS);
      let lastAgentError;
      do {
        this.controller.signal.throwIfAborted();
        if (await this.health()) {
          try {
            await this.assertAgentPresent();
            lastAgentError = undefined;
          } catch (error) {
            // OpenCode may finish /global/health before its agent/plugin
            // registry is ready. Retry transport-only failures within the
            // startup deadline, never a missing agent or HTTP auth error.
            if (error.code !== 'SERVER_AGENT_CHECK_FAILED'
              || !error.message.startsWith('Cannot check OpenCode agent:')) throw error;
            lastAgentError = error;
          }
          if (!lastAgentError && await this.verifyGuard()) {
            this.readyOwned = terminal === null;
            this.logger.info?.('dsh-opencode: local OpenCode server ready at ' + origin);
            return;
          }
        }
        if (terminal !== null) throw failure('OpenCode server ' + terminal, 'SERVER_START_FAILED');
        if (Date.now() >= deadline) break;
        await this.sleepImpl(CHECK_INTERVAL_MS, undefined, { signal: this.controller.signal });
      } while (true);
      if (lastAgentError) throw lastAgentError;
      throw this.guardedRead
        ? failure('OpenCode native-tool guard did not register; refusing model calls',
          'SERVER_GUARD_NOT_READY')
        : failure('OpenCode server startup timed out', 'SERVER_START_TIMEOUT');
    } catch (error) {
      if (this.owned === child) await this.stopOwned();
      throw error;
    }
  }

  async stopOwned() {
    const proof = this.guardProof;
    this.guardProof = null;
    this.guardVerified = false;
    const child = this.owned;
    this.owned = null;
    this.readyOwned = false;
    if (proof) {
      await this.rmImpl(proof.marker, { force: true }).catch(() => {});
      await this.rmImpl(proof.audit, { force: true }).catch(() => {});
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let done = false;
    const exited = new Promise(resolve => {
      const finish = () => { done = true; resolve(); };
      child.once('exit', finish);
      child.once('error', finish);
    });
    try { child.kill(); }
    catch (error) { this.logger.warn?.('dsh-opencode: failed to stop OpenCode process: ' + error.message); }
    await Promise.race([exited, this.sleepImpl(1500)]);
    if (!done && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* The process has already exited. */ }
      await Promise.race([exited, this.sleepImpl(500)]);
    }
  }

  /** Never stop a server that was running before this plugin started. */
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    await this.stopOwned();
    await this.starting?.catch(() => {});
  }
}

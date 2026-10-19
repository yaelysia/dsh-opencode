import { spawn } from 'node:child_process';
import { mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { diagnose, proxySummary } from './doctor.mjs';
import { redact } from '../src/errors.js';
import { childEnvironment } from '../src/service-env.js';
export { childEnvironment } from '../src/service-env.js';

export async function ensurePortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('Port ' + port + ' is unavailable. Stop the previous opencode serve window with Ctrl+C, then retry. No process was killed.')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    exe: { type: 'string' }, port: { type: 'string', default: '4096' }, root: { type: 'string' },
    model: { type: 'string' }, direct: { type: 'boolean', default: false }, probe: { type: 'boolean', default: false },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const local = process.env.LOCALAPPDATA;
  if (!values.exe && !local) throw new Error('Specify --exe with the installed OpenCode executable path');
  const exe = path.resolve(values.exe || path.join(local, 'Programs', 'OpenCodeCLI', 'opencode.exe'));
  const root = path.resolve(values.root || path.join(local || process.cwd(), 'OpenCodeRuntime'));
  await access(exe);
  await ensurePortFree(port);
  const env = childEnvironment(process.env, root, values.direct);
  for (const key of ['XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
    await mkdir(env[key], { recursive: true });
  }
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  console.log('Starting installed OpenCode; child proxy variables:', proxySummary(env));
  if (values.direct) console.log('Direct mode removes only proxy environment variables. System/TUN VPN routing is unchanged.');
  const child = spawn(exe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd, env, stdio: 'inherit', shell: false });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // Attach a rejection handler immediately while startup is being checked.
  exited.catch(() => {});
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const endpoint = 'http://127.0.0.1:' + port;
  const headers = {};
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (password) headers.authorization = 'Basic ' + Buffer.from((env.OPENCODE_SERVER_USERNAME || 'opencode') + ':' + password).toString('base64');
  const startup = new AbortController();
  try {
    const ready = (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const response = await fetch(endpoint + '/global/health', { headers, redirect: 'error', signal: AbortSignal.any([startup.signal, AbortSignal.timeout(1000)]) });
          if (response.ok && (await response.json()).healthy === true) return;
        } catch { startup.signal.throwIfAborted(); }
        // Only poll local startup health, never cloud inference.
        await sleep(500, undefined, { signal: startup.signal });
      }
      throw new Error('OpenCode did not become healthy; check its output above');
    })();
    await Promise.race([ready, exited.then(({ code }) => { throw new Error('OpenCode exited before becoming ready: ' + code); })]);
    const report = await diagnose({ endpoint, probe: values.probe, model: values.model, env });
    report.launch = { directRequested: values.direct, systemVpnChanged: false };
    const file = path.join(root, 'opencode-diagnostic-' + Date.now() + '.json');
    await writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    console.log('Diagnostic report:', file);
    if (!report.ok) { console.error('Check failed. No retry or fallback model was used.'); return 1; }
    console.log('OpenCode is ready at ' + endpoint + '. Keep this window open for DSH; Ctrl+C stops this server.');
    return (await exited).code ?? 0;
  } finally {
    startup.abort();
    stop();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}

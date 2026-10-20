import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { OpenCodeServeClient, DEFAULT_MODELS } from '../src/bridge.js';
import { failure, redact } from '../src/errors.js';

export function proxySummary(env = process.env) {
  return Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(name => [name,
    Object.entries(env).some(([key, value]) => key.toUpperCase() === name && Boolean(value)),
  ]));
}

export async function diagnose(options = {}, fetchImpl) {
  const model = options.model || DEFAULT_MODELS[0];
  const report = { schemaVersion: 1, at: new Date().toISOString(),
    proxyVariablesPresent: proxySummary(options.env), probe: { requested: Boolean(options.probe || options.streamProbe), attempted: false },
  };
  try {
    const client = new OpenCodeServeClient({ ...options, timeoutMs: 10_000 }, fetchImpl);
    report.endpoint = client.origin;
    const health = await client.request('/global/health', undefined, undefined, 'GET');
    report.health = { healthy: health?.healthy === true, version: redact(health?.version ?? 'unknown') };
    if (!report.health.healthy) throw failure('OpenCode health check failed', 'UNHEALTHY');
    // Never dump the full provider/config responses: they may contain credentials.
    let catalog;
    try { catalog = await client.request('/provider', undefined, undefined, 'GET'); }
    catch (error) {
      if (error.failure?.status !== 404) throw error;
      catalog = await client.request('/config/providers', undefined, undefined, 'GET');
    }
    const providers = catalog?.all ?? catalog?.providers;
    if (!Array.isArray(providers)) throw failure('Unrecognized OpenCode provider response', 'CATALOG_ERROR');
    const provider = providers.find(p => p.id === client.backendProviderId);
    const entries = provider?.models;
    const ids = Array.isArray(entries) ? entries.map(m => m.id) : Object.keys(entries ?? {});
    report.models = [...new Set([...DEFAULT_MODELS, model])].map(id => ({ id, listed: ids.includes(id) }));
    report.provider = client.backendProviderId;
    if (!provider) throw failure('Provider missing from OpenCode server', 'PROVIDER_NOT_FOUND');
    if (!ids.includes(model)) throw failure('Requested model missing from OpenCode server: ' + model, 'MODEL_NOT_FOUND');
    const agents = await client.request('/agent', undefined, undefined, 'GET');
    if (!Array.isArray(agents)) throw failure('Unrecognized OpenCode agent response', 'CATALOG_ERROR');
    report.agent = { name: client.agent, listed: agents.some(a => a.name === client.agent) };
    if (!report.agent.listed) throw failure('Requested agent missing from OpenCode server', 'AGENT_NOT_FOUND');
    if (options.probe || options.streamProbe) {
      if (!model.endsWith('-free')) throw failure('Diagnostic probe only accepts explicit -free model IDs', 'INVALID_REQUEST');
      client.timeoutMs = 90_000;
      report.probe = { requested: true, attempted: true, model };
      let output;
      if (options.streamProbe) {
        const started = Date.now();
        const snapshots = [];
        for await (const item of client.streamResponse({
          model, messages: [{ role: 'user', content:
            'Write the integers from 1 to 40, separated by commas. No additional text.' }],
        })) {
          if (item.kind === 'snapshot') {
            snapshots.push({ milliseconds: Date.now() - started, chars: item.text.length });
          } else {
            output = item.response;
          }
        }
        report.probe.streaming = {
          observedSnapshots: snapshots.length,
          firstSnapshotMs: snapshots[0]?.milliseconds ?? null,
          lastSnapshotChars: snapshots.at(-1)?.chars ?? 0,
          responseMs: Date.now() - started,
        };
        if (!snapshots.length) {
          throw failure('OpenCode SSE did not deliver any assistant text while the model was responding', 'SSE_NO_DELTAS');
        }
      } else {
        output = await client.complete({ model, messages: [{ role: 'user', content: 'Reply with exactly the digit 1.' }] });
      }
      report.probe.text = redact(output.parts.filter(p => p.type === 'text').map(p => p.text).join('')).slice(0, 80);
      if (output.info?.modelID) report.probe.reportedModel = output.info.modelID;
    }
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = { code: error.code || 'UNKNOWN', message: redact(error.message),
      ...(error.failure?.status ? { status: error.failure.status } : {}),
    };
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    endpoint: { type: 'string' }, model: { type: 'string' }, agent: { type: 'string' },
    probe: { type: 'boolean', default: false }, 'stream-probe': { type: 'boolean', default: false },
    out: { type: 'string' },
  } });
  const report = await diagnose({ ...values, streamProbe: values['stream-probe'] });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.out) await writeFile(values.out, json, { mode: 0o600 });
  console.log(json);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}

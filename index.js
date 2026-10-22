import Schema from '@deepseek-ai/schemastery';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { DEFAULT_MODELS } from './src/bridge.js';
import { createPluginRuntime } from './src/runtime.js';
import { BRIDGE_AGENT_ID } from './src/managed-agent.js';

export const name = 'opencode-serve';
export const inject = ['llm'];

export const Config = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:4096').volatile(),
  backendProviderId: Schema.string().default('opencode'),
  providerId: Schema.string().default('opencode-serve'),
  agent: Schema.string().default(BRIDGE_AGENT_ID),
  username: Schema.string().default('opencode').volatile(),
  passwordEnv: Schema.string().default('OPENCODE_SERVER_PASSWORD').volatile(),
  localTitles: Schema.boolean().default(true).volatile(),
  toolBridgeEnabled: Schema.boolean().default(true).volatile(),
  structuredToolsEnabled: Schema.boolean().default(false).volatile(),
  guardedReadCompatibility: Schema.boolean().default(false).volatile(),
  // SSE is experimental until the user's actual OpenCode service is verified.
  ssePreviewEnabled: Schema.boolean().default(false).volatile(),
  strictOwnedServer: Schema.boolean().default(true).volatile(),
  autoStart: Schema.boolean().default(true).volatile(),
  autoStartDirect: Schema.boolean().default(true).volatile(),
  opencodeExecutable: Schema.string().default('').volatile(),
  runtimeRoot: Schema.string().default('').volatile(),
  autoStartTimeoutMs: Schema.number().min(1).max(2147483647).default(15000).volatile(),
  // Idle OpenCode sessions can be retained across days while DSH remains running.
  sessionIdleHours: Schema.number().min(1).max(2160).default(168).volatile(),
  diagnosticsEnabled: Schema.boolean().default(true).volatile(),
  diagnosticsPort: Schema.number().min(1024).max(65535).default(4097).volatile(),
  timeoutMs: Schema.number().min(1).max(2147483647).default(120000).volatile(),
  models: Schema.array(Schema.string()).default([...DEFAULT_MODELS]).volatile(),
});

class ModelAdapter extends LlmAdapter {
  constructor(implementation) {
    super();
    Object.assign(this, implementation);
  }
}

// SettingsForms publishes Volatile<T> references. Pin one coherent config
// snapshot for every OpenCode child/adapter lifetime; saving the UI requires
// a Desktop restart before the new transport/security boundaries take effect.
export function configSnapshot(config) {
  return Object.fromEntries(Object.entries(config).map(([field, value]) => [
    field, value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value,
  ]));
}

export function apply(ctx, config) {
  const options = configSnapshot(config);
  const runtime = createPluginRuntime({ ...options, logger: ctx.logger,
    attributionHeaders: attributionHeaders() }, { logger: ctx.logger });
  const provider = options.providerId || 'opencode-serve';
  ctx.llm.registerAdapter([provider], new ModelAdapter(runtime.adapter));
  ctx.llm.registerConfigurableProviders?.([{
    provider,
    displayName: 'OpenCode (official serve)',
    settingsNs: ctx?.fiber?.entry?.options?.id ?? name,
    settingsPath: [],
  }]);
  // Cordis owns the lifecycle: only stop a process spawned by this instance.
  ctx.effect(() => {
    void runtime.ready().catch(error => {
      if (!runtime.supervisor.closed) ctx.logger.warn?.('dsh-opencode: OpenCode auto-start failed: ' + error.message);
    });
    return () => runtime.dispose();
  }, 'dsh-opencode: manage local OpenCode server');
}

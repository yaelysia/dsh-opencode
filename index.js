import Schema from '@deepseek-ai/schemastery';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createAdapter, DEFAULT_MODELS } from './src/bridge.js';
import { OpenCodeService } from './src/service.js';
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
  guardedReadCompatibility: Schema.boolean().default(false).volatile(),
  // SSE is experimental until the user's actual OpenCode service is verified.
  ssePreviewEnabled: Schema.boolean().default(false).volatile(),
  strictOwnedServer: Schema.boolean().default(true).volatile(),
  autoStart: Schema.boolean().default(true).volatile(),
  autoStartDirect: Schema.boolean().default(true).volatile(),
  opencodeExecutable: Schema.string().default('').volatile(),
  runtimeRoot: Schema.string().default('').volatile(),
  autoStartTimeoutMs: Schema.number().min(1).max(2147483647).default(15000).volatile(),
  timeoutMs: Schema.number().min(1).max(2147483647).default(120000).volatile(),
  models: Schema.array(Schema.string()).default([...DEFAULT_MODELS]).volatile(),
});

class ModelAdapter extends LlmAdapter {
  constructor(config, logger) {
    super();
    Object.assign(this, createAdapter({ ...config, logger, attributionHeaders: attributionHeaders() }));
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
  const supervisor = new OpenCodeService(options, { logger: ctx.logger });
  const provider = options.providerId || 'opencode-serve';
  ctx.llm.registerAdapter([provider], new ModelAdapter({
    ...options,
    passwordProvider: () => supervisor.passwordForClient(),
    ensureService: ({ requireManaged } = {}) => supervisor.ready({
      requireManaged: options.strictOwnedServer !== false || requireManaged === true
        || options.guardedReadCompatibility === true,
    }),
  }, ctx.logger));
  ctx.llm.registerConfigurableProviders?.([{
    provider,
    displayName: 'OpenCode (official serve)',
    settingsNs: ctx?.fiber?.entry?.options?.id ?? name,
    settingsPath: [],
  }]);
  // Cordis owns the lifecycle: only stop a process spawned by this instance.
  ctx.effect(() => {
    void supervisor.ready().catch(error => {
      if (!supervisor.closed) ctx.logger.warn?.('dsh-opencode: OpenCode auto-start failed: ' + error.message);
    });
    return () => supervisor.dispose();
  }, 'dsh-opencode: manage local OpenCode server');
}

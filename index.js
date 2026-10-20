import Schema from '@deepseek-ai/schemastery';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createAdapter, DEFAULT_MODELS } from './src/bridge.js';
import { OpenCodeService } from './src/service.js';
import { BRIDGE_AGENT_ID } from './src/managed-agent.js';

export const name = 'opencode-serve';
export const inject = ['llm'];

export const Config = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:4096'),
  backendProviderId: Schema.string().default('opencode'),
  providerId: Schema.string().default('opencode-serve'),
  agent: Schema.string().default(BRIDGE_AGENT_ID),
  username: Schema.string().default('opencode'),
  passwordEnv: Schema.string().default('OPENCODE_SERVER_PASSWORD'),
  localTitles: Schema.boolean().default(true),
  toolBridgeEnabled: Schema.boolean().default(true),
  streamingEnabled: Schema.boolean().default(true),
  strictOwnedServer: Schema.boolean().default(true),
  autoStart: Schema.boolean().default(true),
  autoStartDirect: Schema.boolean().default(true),
  opencodeExecutable: Schema.string().default(''),
  runtimeRoot: Schema.string().default(''),
  autoStartTimeoutMs: Schema.number().default(15000),
  timeoutMs: Schema.number().default(120000),
  models: Schema.array(Schema.string()).default([...DEFAULT_MODELS]),
});

class ModelAdapter extends LlmAdapter {
  constructor(config, logger) {
    super();
    Object.assign(this, createAdapter({ ...config, logger, attributionHeaders: attributionHeaders() }));
  }
}

export function apply(ctx, config) {
  const supervisor = new OpenCodeService(config, { logger: ctx.logger });
  const provider = config.providerId || 'opencode-serve';
  ctx.llm.registerAdapter([provider], new ModelAdapter({
    ...config,
    passwordProvider: () => supervisor.passwordForClient(),
    ensureService: ({ requireManaged } = {}) => supervisor.ready({
      requireManaged: config.strictOwnedServer !== false || requireManaged === true,
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

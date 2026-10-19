import Schema from '@deepseek-ai/schemastery';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createAdapter, DEFAULT_MODELS } from './src/bridge.js';

export const name = 'opencode-serve';
export const inject = ['llm'];

export const Config = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:4096'),
  backendProviderId: Schema.string().default('opencode'),
  providerId: Schema.string().default('opencode-serve'),
  agent: Schema.string().default('plan'),
  username: Schema.string().default('opencode'),
  passwordEnv: Schema.string().default('OPENCODE_SERVER_PASSWORD'),
  models: Schema.array(Schema.string()).default([...DEFAULT_MODELS]),
});

class ModelAdapter extends LlmAdapter {
  constructor(config) {
    super();
    Object.assign(this, createAdapter({ ...config, attributionHeaders: attributionHeaders() }));
  }
}

export function apply(ctx, config) {
  const provider = config.providerId || 'opencode-serve';
  ctx.llm.registerAdapter([provider], new ModelAdapter(config));
  ctx.llm.registerConfigurableProviders?.([{
    provider,
    displayName: 'OpenCode (official serve)',
    settingsNs: ctx?.fiber?.entry?.options?.id ?? name,
    settingsPath: [],
  }]);
}

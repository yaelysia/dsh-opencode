import Schema from '@deepseek-ai/schemastery';
import { createAdapter, DEFAULT_MODELS } from './src/bridge.js';

export const name = 'dsh-opencode';
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

export function apply(ctx, config) {
  const adapter = createAdapter(config);
  const provider = config.providerId || 'opencode-serve';
  ctx.llm.registerAdapter([provider], adapter);
  ctx.llm.registerConfigurableProviders?.([{
    provider,
    displayName: 'OpenCode (official serve)',
    settingsNs: ctx?.fiber?.entry?.options?.id ?? name,
    settingsPath: [],
  }]);
}

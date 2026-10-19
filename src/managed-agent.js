/** Only the managed OpenCode child receives this configuration. */
export const BRIDGE_AGENT_ID = 'dsh-bridge';

export const BRIDGE_PROMPT = [
  'Follow the supplied system instructions and user messages.',
  'Respond directly to the task. Do not introduce a separate OpenCode identity,',
  'Plan/Build workflow, or instructions to switch to another mode.',
  'Do not invoke tools; DSH owns tool access and permission decisions.',
].join(' ');

/**
 * OpenCode v1.19.3 accepts OPENCODE_CONFIG_CONTENT with an agent object.
 * An agent.prompt replaces the default provider persona, not the per-request
 * system field from DSH. Keep one read-only compatibility tool: the upstream
 * free-tier gate may reject requests without an agent tool definition.
 */
export function managedAgentDefinition() {
  return {
    description: 'Text-only bridge for DeepSeek Harness.',
    mode: 'primary',
    prompt: BRIDGE_PROMPT,
    permission: {
      '*': 'deny',
      read: 'allow',
      external_directory: 'deny',
    },
  };
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Merge with pre-existing process config without mutating the input. */
export function managedAgentEnvironment(env, agentId = BRIDGE_AGENT_ID) {
  if (agentId !== BRIDGE_AGENT_ID) return { ...env };
  let config = {};
  const raw = env.OPENCODE_CONFIG_CONTENT;
  if (raw) {
    try { config = JSON.parse(raw); }
    catch { throw new Error('OPENCODE_CONFIG_CONTENT must be valid JSON to add the DSH agent'); }
    if (!record(config)) throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object');
  }
  if (config.agent !== undefined && !record(config.agent)) {
    throw new Error('OPENCODE_CONFIG_CONTENT.agent must be an object');
  }
  if (Object.hasOwn(config.agent ?? {}, agentId)) {
    throw new Error('OpenCode already has a config entry named ' + agentId);
  }
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      agent: { ...(config.agent ?? {}), [agentId]: managedAgentDefinition() },
    }),
  };
}

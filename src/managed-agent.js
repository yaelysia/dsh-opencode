import path from 'node:path';

export const BRIDGE_AGENT_ID = 'dsh-bridge';
export const BRIDGE_PROMPT = [
  'Follow the supplied system instructions and user messages.',
  'You are acting as a text-only model transport for DeepSeek Harness.',
  'Do not perform OpenCode tool execution or introduce OpenCode Plan/Build flows.',
  'DSH is the only authority for tool approval and execution.',
].join(' ');

export function managedAgentDefinition() {
  return {
    description: 'Text-only bridge for DeepSeek Harness.',
    mode: 'primary',
    prompt: BRIDGE_PROMPT,
    permission: { '*': 'deny' },
  };
}

/**
 * Do not inherit global OpenCode plugins/agent/tool permissions into the DSH
 * model transport. Auth/data remain in the existing XDG_DATA_HOME.
 */
export function managedAgentEnvironment(env, agentId = BRIDGE_AGENT_ID, root) {
  if (agentId !== BRIDGE_AGENT_ID) return { ...env };
  if (env.OPENCODE_CONFIG_CONTENT) {
    let existing;
    try { existing = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('OPENCODE_CONFIG_CONTENT must be valid JSON'); }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object');
    }
    if (existing.agent !== undefined && (typeof existing.agent !== 'object'
      || existing.agent === null || Array.isArray(existing.agent))) {
      throw new Error('OPENCODE_CONFIG_CONTENT.agent must be an object');
    }
    if (Object.hasOwn(existing.agent ?? {}, agentId)) {
      throw new Error('OpenCode already has a config entry named ' + agentId);
    }
  }
  const result = { ...env };
  delete result.OPENCODE_CONFIG;
  delete result.OPENCODE_CONFIG_DIR;
  result.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  if (root) result.XDG_CONFIG_HOME = path.join(root, 'dsh-isolated-config');
  result.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    agent: { [agentId]: managedAgentDefinition() },
    plugin: [], mcp: {},
  });
  return result;
}

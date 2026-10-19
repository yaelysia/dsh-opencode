import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRIDGE_AGENT_ID,
  BRIDGE_PROMPT,
  managedAgentDefinition,
  managedAgentEnvironment,
} from '../src/managed-agent.js';

test('dedicated agent has minimal system prompt without Plan persona', () => {
  const agent = managedAgentDefinition();
  assert.equal(BRIDGE_AGENT_ID, 'dsh-bridge');
  assert.equal(agent.mode, 'primary');
  assert.equal(agent.prompt, BRIDGE_PROMPT);
  assert.doesNotMatch(agent.prompt, /You are OpenCode|currently in Plan mode|switch to Build/i);
  assert.equal(agent.permission['*'], 'deny');
  assert.equal(agent.permission.read, 'allow');
  assert.equal(agent.permission.external_directory, 'deny');
});

test('isolates new agent config to child environment and preserves existing settings', () => {
  const parent = {
    HTTP_PROXY: 'http://proxy',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      theme: 'light',
      agent: { reviewer: { mode: 'subagent', prompt: 'Review code' } },
    }),
  };
  const child = managedAgentEnvironment(parent);
  const cfg = JSON.parse(child.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.theme, 'light');
  assert.equal(cfg.agent.reviewer.prompt, 'Review code');
  assert.equal(cfg.agent['dsh-bridge'].prompt, BRIDGE_PROMPT);
  assert.equal(parent.OPENCODE_CONFIG_CONTENT.includes('dsh-bridge'), false);
  assert.equal(child.HTTP_PROXY, parent.HTTP_PROXY);
});

test('does not mutate global config when using an explicit non-bridge agent', () => {
  const parent = { OPENCODE_CONFIG_CONTENT: '{invalid', CUSTOM: 'a' };
  const child = managedAgentEnvironment(parent, 'plan');
  assert.deepEqual(child, parent);
  assert.notEqual(child, parent);
});

test('injects into an empty environment', () => {
  const child = managedAgentEnvironment({});
  assert.equal(JSON.parse(child.OPENCODE_CONFIG_CONTENT).agent[BRIDGE_AGENT_ID].mode, 'primary');
});

test('fails on corrupt existing config instead of discarding it', () => {
  assert.throws(() => managedAgentEnvironment({ OPENCODE_CONFIG_CONTENT: '{' }), /valid JSON/);
  assert.throws(() => managedAgentEnvironment({ OPENCODE_CONFIG_CONTENT: '[]' }), /JSON object/);
  assert.throws(() => managedAgentEnvironment({
    OPENCODE_CONFIG_CONTENT: '{"agent":[]}',
  }), /agent must be an object/);
});

test('does not overwrite a user-owned agent with the same ID', () => {
  assert.throws(() => managedAgentEnvironment({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { [BRIDGE_AGENT_ID]: { prompt: 'personal' } } }),
  }), /already has a config entry/);
});

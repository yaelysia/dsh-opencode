import { randomUUID } from 'node:crypto';
import { failure } from './errors.js';

export const TOOL_CALL_PREFIX = 'DSH_TOOL_CALL_V1:';
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_CALL_BYTES = 64 * 1024;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Convert only active DSH schemas into model-visible descriptions. */
export function toolInstructions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const names = new Set();
  const list = tools.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name || names.has(item.name)
      || typeof item.description !== 'string' || !object(item.parameters)) {
      throw failure('Invalid or duplicated DSH tool declaration', 'INVALID_TOOL_SCHEMA');
    }
    names.add(item.name);
    return { name: item.name, description: item.description, parameters: item.parameters };
  });
  const json = JSON.stringify(list);
  if (Buffer.byteLength(json, 'utf8') > MAX_SCHEMA_BYTES) {
    throw failure('DSH tool schemas exceed the safe bridge request size', 'TOOL_SCHEMA_TOO_LARGE');
  }
  return [
    'DSH TOOL PROTOCOL V1. OpenCode tools are disabled; you do not have direct filesystem,',
    'shell, network, or other tool execution privileges in OpenCode.',
    'Only the DSH host can execute the tools defined below, subject to its authorization.',
    'To request exactly ONE tool call, your ENTIRE assistant response MUST be one line:',
    TOOL_CALL_PREFIX + '{"name":"exact_tool_name","arguments":{"key":"value"}}',
    'Use strictly valid JSON with an arguments object. Do not use Markdown fences or extra text.',
    'If no tool is needed, respond normally in natural language, WITHOUT the tool prefix.',
    'Do not forge tool results. After DSH provides a tool result, continue reasoning or answer.',
    'Available DSH tools (JSON schemas, not OpenCode executable tools):',
    json,
  ].join('\n');
}

/** Fail closed on any sign the OpenCode host itself used a tool. */
export function assertNoOpenCodeToolParts(parts) {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (part && ['tool','tool-call','tool-result','tool_call','tool_result'].includes(part.type)) {
      throw failure('OpenCode returned an internal tool event; DSH-only tool isolation failed',
        'OPENCODE_TOOL_BOUNDARY');
    }
  }
}

/** Parse an explicit text protocol; never execute a tool in this module. */
export function parseToolRequest(output, tools) {
  const text = String(output || '').trim();
  if (!text.startsWith(TOOL_CALL_PREFIX)) return null;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw failure('Tool call requested when DSH offered no tools', 'UNDECLARED_TOOL_CALL');
  }
  const raw = text.slice(TOOL_CALL_PREFIX.length).trim();
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CALL_BYTES) {
    throw failure('Model tool-call payload is empty or oversized', 'INVALID_TOOL_CALL');
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw failure('Model tool-call payload is not valid JSON', 'INVALID_TOOL_CALL'); }
  if (!object(value) || typeof value.name !== 'string' || !object(value.arguments)
    || Object.keys(value).some(key => key !== 'name' && key !== 'arguments')) {
    throw failure('Model tool-call payload does not match the DSH envelope', 'INVALID_TOOL_CALL');
  }
  if (!tools.some(tool => tool.name === value.name)) {
    throw failure('Model called a tool not declared by DSH', 'UNDECLARED_TOOL_CALL');
  }
  return { id: 'call_' + randomUUID(), name: value.name, arguments: JSON.stringify(value.arguments) };
}

/** Preserve tool-result attribution for next model turn without executing it. */
export function renderConversationMessage(message, textOf) {
  const role = message?.role || 'user';
  if (role === 'tool') {
    const id = message.toolCallId || message.source?.callId || 'unknown';
    return 'DSH tool result (callId=' + JSON.stringify(id) + ', error=' +
      (message.isError === true) + '):\n' + textOf(message.content);
  }
  const parts = Array.isArray(message?.content) ? message.content : [];
  const calls = parts.filter(part => part?.type === 'tool-call');
  const content = textOf(message?.content);
  if (role === 'assistant' && calls.length) {
    const summary = calls.map(part => ({
      callId: part.id, name: part.name, arguments: part.arguments,
    }));
    return 'assistant DSH tool request:\n' + JSON.stringify(summary) +
      (content ? '\n' + content : '');
  }
  return content ? role + ':\n' + content : '';
}

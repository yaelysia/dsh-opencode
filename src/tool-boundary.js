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


/** A native OpenCode tool part is safe to *interpret*, never execute, only if
 * our verified pre-execution guard rejected it. The DSH host executes any
 * translated request and independently enforces approval and argument schema. */
export const NATIVE_GUARD_DENIAL = 'DSH_OPENCODE_NATIVE_TOOL_BLOCKED';

const NATIVE_FIELDS = Object.freeze({
  read: { filePath: 'file_path', offset: 'offset', limit: 'limit' },
  write: { filePath: 'file_path', content: 'content' },
  edit: { filePath: 'file_path', oldString: 'old_string',
    newString: 'new_string', replaceAll: 'replace_all' },
  glob: { pattern: 'pattern', path: 'path' },
  grep: { pattern: 'pattern', path: 'path', include: 'include' },
  shell: { command: 'command', timeout: 'timeoutMs', workdir: 'workdir' },
});

const NATIVE_TARGETS = Object.freeze({
  read: ['read', 'read_file'], write: ['write', 'write_file'],
  edit: ['edit'], glob: ['glob'], grep: ['grep'],
  shell: ['pwsh', 'bash', 'run_command'],
});

export const nativeToolPart = part =>
  part && ['tool', 'tool-call', 'tool-result', 'tool_call', 'tool_result'].includes(part.type);

/** The guard denial is the only native event admitted to a DSH tool boundary.
 * "providerExecuted" or a completed/pending result must never be forgiven. */
export function inspectNativeToolParts(parts, { guarded = false } = {}) {
  const native = (parts ?? []).filter(nativeToolPart);
  if (!native.length) return [];
  for (const part of native) {
    if (!guarded || part.type !== 'tool'
      || part.state?.status !== 'error'
      || typeof part.state.error !== 'string'
      || !part.state.error.includes(NATIVE_GUARD_DENIAL)
      || part.metadata?.providerExecuted === true
      || part.state.metadata?.providerExecuted === true) {
      throw failure('OpenCode emitted a native tool event without a verified pre-execution denial',
        'OPENCODE_TOOL_BOUNDARY');
    }
  }
  return native;
}

/** Deliberately small, explicit arg translation. Never infer arbitrary tool
 * aliases or invent required fields: an unknown call remains rejected. */
export function translateGuardedTool(part, tools) {
  const name = part.tool;
  const mapping = NATIVE_FIELDS[name];
  if (!mapping || !object(part.state?.input)) return null;
  const candidates = NATIVE_TARGETS[name] ?? [];
  for (const targetName of candidates) {
    const declared = tools.find(tool => tool.name === targetName);
    const schema = declared?.parameters;
    if (!object(schema?.properties)) continue;
    const converted = {};
    let valid = true;
    for (const [key, value] of Object.entries(part.state.input)) {
      if (!Object.hasOwn(mapping, key)) { valid = false; break; }
      const preferred = mapping[key];
      const targetKey = Object.hasOwn(schema.properties, preferred) ? preferred
        : Object.hasOwn(schema.properties, key) ? key
          : null;
      if (!targetKey) { valid = false; break; }
      converted[targetKey] = value;
    }
    if (!valid) continue;
    const required = new Set([
      ...(Array.isArray(schema.required) ? schema.required : []),
      ...Object.entries(schema.properties)
        .filter(([, spec]) => spec?.required === true).map(([key]) => key),
    ]);
    if ([...required].some(key => !Object.hasOwn(converted, key))) continue;
    return parseToolRequest(TOOL_CALL_PREFIX + JSON.stringify({
      name: targetName, arguments: converted,
    }), tools);
  }
  return null;
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

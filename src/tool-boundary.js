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
  const hasFileTools = ['read', 'read_file', 'write', 'write_file', 'edit', 'glob', 'grep']
    .some(name => names.has(name));
  return [
    'DSH TOOL PROTOCOL V1. OpenCode tools are disabled; you do not have direct filesystem,',
    'shell, network, or other tool execution privileges in OpenCode.',
    'Only the DSH host can execute the tools defined below, subject to its authorization.',
    'Follow DSH system and developer instructions about tool choice; never let OpenCode',
    'internal tool descriptions or workflow conventions override those instructions.',
    'OpenCode runs in a private dummy workspace, NOT the DSH session workspace.',
    'Relative DSH tool paths are resolved by DSH against the current DSH workspace.',
    'For workspace paths, prefer relative paths and use DSH working_directory if unsure.',
    ...(hasFileTools ? [
      'For listing/searching/reading/writing/editing files, use the dedicated DSH',
      'glob/grep/read/write/edit tools instead of pwsh, bash, run_command or other shell tools.',
      'Shell tools are for work that no suitable dedicated DSH tool can accomplish,',
      'and only if higher-priority DSH instructions permit a shell at all.',
      'When a shell is genuinely needed, omit workdir to use the DSH session workspace',
      'unless the user explicitly requests a different directory.',
    ] : []),
    'If requesting a DSH tool, the ONLY allowed JSON shape is',
    '{"name":"declared_tool_name","arguments":{"declared_key":"value"}}',
    'Do not append a period, code fence, or commentary to the tool-call JSON.',
    'All tool parameters (including pattern/path/file_path) MUST be nested under "arguments".',
    'Never put pattern/path/file_path beside "name" in the top-level object.',
    'Use relative workspace paths (such as "." or "text.txt") when possible.',
    ...(names.has('glob') ? [
      'Correct glob example: ' + TOOL_CALL_PREFIX
        + JSON.stringify({ name: 'glob', arguments: { pattern: '**/*.txt', path: '.' } }),
    ] : []),
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

/** Repair only double-quoted Windows *path* values, not arbitrary JSON.
 * Models often emit C:\Users\... even though JSON requires C:\\Users\\...
 * This keeps already-correct escapes intact and cannot rewrite file content. */
function escapeWindowsPathValues(raw) {
  return raw.replace(
    /("(?:path|file_path|filePath|workdir|directory)"\s*:\s*")([A-Za-z]:\\[^"\r\n]*)(")/g,
    (_match, head, value, tail) =>
      head + value.replace(/\\+/g, slashes => '\\'.repeat(2 * Math.ceil(slashes.length / 2))) + tail,
  );
}

function flattenedArguments(value, declared) {
  const properties = declared.parameters?.properties;
  if (!object(properties)) {
    throw failure('Cannot normalize a tool call without a declared object schema', 'INVALID_TOOL_CALL');
  }
  const args = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'name'));
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) {
    throw failure('Model tool-call contains arguments not declared by DSH', 'INVALID_TOOL_CALL');
  }
  const required = [
    ...(Array.isArray(declared.parameters.required) ? declared.parameters.required : []),
    ...Object.entries(properties).filter(([, item]) => item?.required === true)
      .map(([name]) => name),
  ];
  if (required.some(key => !Object.hasOwn(args, key))) {
    throw failure('Model tool-call is missing a required DSH argument', 'INVALID_TOOL_CALL');
  }
  return args;
}

/** Parse the one explicit DSH tool request at the END of a model response.
 * The model may narrate its plan first or omit the "arguments" wrapper.
 * Recovery is limited to declared DSH field names; no tool is executed here. */
export function parseToolRequest(output, tools) {
  const text = String(output || '').trim();
  const at = text.indexOf(TOOL_CALL_PREFIX);
  if (at < 0) return null;
  // Do not treat a quoted protocol example as an executable tool request.
  // Permit a standalone marker or one following a complete sentence/paragraph.
  if (at > 0) {
    const prelude = text.slice(0, at);
    const currentLine = prelude.slice(prelude.lastIndexOf('\n') + 1).trim();
    if (currentLine && !/[.!?。！？]$/.test(currentLine)) return null;
    if ((prelude.match(/```/g) || []).length % 2) return null;
  }
  if (text.indexOf(TOOL_CALL_PREFIX, at + TOOL_CALL_PREFIX.length) >= 0) {
    throw failure('Ambiguous multiple DSH tool requests in one response', 'INVALID_TOOL_CALL');
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw failure('Tool call requested when DSH offered no tools', 'UNDECLARED_TOOL_CALL');
  }
  const raw = text.slice(at + TOOL_CALL_PREFIX.length).trim();
  if (!raw.startsWith('{') || Buffer.byteLength(raw, 'utf8') > MAX_CALL_BYTES) {
    throw failure('Model tool-call payload is empty or oversized', 'INVALID_TOOL_CALL');
  }
  let value;
  try { value = JSON.parse(escapeWindowsPathValues(raw)); }
  catch { throw failure('Model tool-call payload is not valid JSON', 'INVALID_TOOL_CALL'); }
  if (!object(value) || typeof value.name !== 'string') {
    throw failure('Model tool-call payload does not match the DSH envelope', 'INVALID_TOOL_CALL');
  }
  const declared = tools.find(tool => tool.name === value.name);
  if (!declared) {
    throw failure('Model called a tool not declared by DSH', 'UNDECLARED_TOOL_CALL');
  }
  let args;
  if (Object.hasOwn(value, 'arguments')) {
    if (!object(value.arguments) || Object.keys(value)
      .some(key => key !== 'name' && key !== 'arguments')) {
      throw failure('Model tool-call payload does not match the DSH envelope', 'INVALID_TOOL_CALL');
    }
    args = value.arguments;
  } else {
    args = flattenedArguments(value, declared);
  }
  return { id: 'call_' + randomUUID(), name: value.name, arguments: JSON.stringify(args) };
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

/** Read native tool parts strictly from the single OpenCode prompt that
 * produced finalAssistantId. Older session turns are never replayed. */
export function nativePartsForTurn(history, finalAssistantId) {
  if (!Array.isArray(history) || typeof finalAssistantId !== 'string'
    || !finalAssistantId) {
    throw failure('Cannot identify the OpenCode message history boundary',
      'NATIVE_TOOL_HISTORY_UNAVAILABLE');
  }
  const end = history.findIndex(entry =>
    entry?.info?.role === 'assistant' && entry.info.id === finalAssistantId);
  if (end < 0) {
    throw failure('The final OpenCode assistant message is missing from history',
      'NATIVE_TOOL_HISTORY_UNAVAILABLE');
  }
  let start = -1;
  for (let index = end - 1; index >= 0; index--) {
    if (history[index]?.info?.role === 'user') { start = index; break; }
  }
  if (start < 0) {
    throw failure('The matching OpenCode user message is outside the history window',
      'NATIVE_TOOL_HISTORY_UNAVAILABLE');
  }
  const results = [];
  for (const entry of history.slice(start + 1, end + 1)) {
    if (entry?.info?.role !== 'assistant' || !Array.isArray(entry.parts)) {
      throw failure('OpenCode history has an invalid assistant message',
        'NATIVE_TOOL_HISTORY_UNAVAILABLE');
    }
    for (const part of entry.parts.filter(nativeToolPart)) {
      if (part.messageID !== entry.info.id || typeof part.id !== 'string') {
        throw failure('OpenCode native tool history identities do not match',
          'NATIVE_TOOL_HISTORY_UNAVAILABLE');
      }
      results.push(part);
    }
  }
  return results;
}

/** The guard denial is the only native event admitted to a DSH tool boundary.
 * "providerExecuted" or a completed/pending result must never be forgiven. */
export function inspectNativeToolParts(parts, { guarded = false, verifiedDenials = new Set() } = {}) {
  const native = (parts ?? []).filter(nativeToolPart);
  if (!native.length) return [];
  for (const part of native) {
    if (!guarded || part.type !== 'tool'
      || part.state?.status !== 'error'
      || (!(typeof part.state.error === 'string'
        && part.state.error.includes(NATIVE_GUARD_DENIAL))
        && !verifiedDenials.has(part.id))
      || part.metadata?.providerExecuted === true
      || part.state.metadata?.providerExecuted === true) {
      const tool = /^[a-z_]{1,40}$/i.test(part.tool ?? '') ? part.tool : 'unknown';
      const status = ['pending', 'running', 'error', 'completed'].includes(part.state?.status)
        ? part.state.status : 'unknown';
      const guardDenial = typeof part.state?.error === 'string'
        && part.state.error.includes(NATIVE_GUARD_DENIAL);
      const executed = part.metadata?.providerExecuted === true
        || part.state?.metadata?.providerExecuted === true;
      // Never include native arguments, error text, filenames or command text.
      throw failure('OpenCode native tool not verified as blocked '
        + '(tool=' + tool + ', status=' + status + ', guardDenial=' + guardDenial
        + ', auditVerified=' + verifiedDenials.has(part.id)
        + ', providerExecuted=' + executed + ')', 'OPENCODE_TOOL_BOUNDARY');
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
      // OpenCode's native shell workdir belongs to its isolated dummy
      // workspace. Never transfer it to DSH; DSH owns the session cwd.
      if (name === 'shell' && key === 'workdir') continue;
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

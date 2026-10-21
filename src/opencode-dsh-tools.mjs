import { writeFile } from 'node:fs/promises';

/** Managed child only. Uses OpenCode 1.19.3's plugin-tool JSON Schema
 * compatibility path without a second install or npm dependency. */

/** Model-facing routing: a single stable OpenCode tool, plus the DSH catalog
 * for this exact turn. PTC mode is inferred from DSH's visible run_code tool. */
export function structuredToolGuidance(tools = []) {
  const names = Array.isArray(tools) ? tools.map(tool => tool?.name)
    .filter(name => typeof name === 'string' && name.length > 0) : [];
  const ptc = names.length === 1 && names[0] === 'run_code';
  const rules = [
    'DSH TOOL ROUTING — follow these rules whenever the request requires tools:',
    'The ONLY permitted tool gateway is the registered OpenCode plugin tool dsh_call.',
    'Other built-in OpenCode tools (read, glob, grep, edit, write, bash, shell, etc.)',
    'may be visible for model compatibility, but are NOT usable and WILL fail.',
    'Never try a native OpenCode tool first. Do not use Plan/Build tool flows.',
    'If the user request needs an available DSH tool, invoke dsh_call directly',
    'rather than debating the tool choice, writing a textual tool-call envelope,',
    'or claiming the operation was completed without a DSH result.',
    'Call dsh_call with ONE structured input object containing precisely two fields:',
    'name = the exact tool name in the current DSH catalog, and arguments = an',
    'object matching the declared JSON schema. Do not emit raw tool JSON as text.',
    'DSH owns all approvals, execution, working directories, and tool results.',
    'Wait for the DSH tool result before deciding the next action.',
    'Follow higher-priority DSH instructions, including the user response language.',
  ];
  if (!names.length) {
    rules.push('No DSH tools are available now. Do not call dsh_call or native OpenCode tools.');
  } else if (ptc) {
    rules.push(
      'DSH PTC mode is active. The ONLY DSH tool you can request is run_code.',
      'To use any DSH SDK tool, call dsh_call with name="run_code" and arguments',
      'containing code and description as required by the run_code schema.',
      'The code must use the generated DSH SDK (await tools.name(args)) inside',
      'the PTC program, using the language required by DSH (the built-in preset',
      'uses TypeScript). Do not infer another SDK from OpenCode tools.',
      'Do not call SDK tools directly as OpenCode tools. Keep permissions under DSH.',
    );
  } else {
    rules.push(
      'DSH native tool presentation is active. Select an appropriate name',
      'from the declared DSH catalog; invoke it through dsh_call, never directly',
      'as an OpenCode built-in tool. Do not use run_code unless DSH declares it.',
    );
  }
  return rules.join('\n');
}

export const DshStructuredTools = async () => {
  const origin = process.env.DSH_STRUCTURED_URL;
  const token = process.env.DSH_STRUCTURED_TOKEN;
  const marker = process.env.DSH_OPENCODE_GUARD_MARKER;
  const nonce = process.env.DSH_OPENCODE_GUARD_NONCE;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '')
    || !/^[a-f0-9]{64}$/.test(token ?? '') || !marker || !/^[a-f0-9]{64}$/.test(nonce ?? '')) {
    throw new Error('DSH structured plugin requires a private managed server');
  }
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  return {
    async config() { await writeFile(marker, nonce, { mode: 0o600 }); },
    tool: { dsh_call: {
      description: 'The ONLY valid gateway to DSH workspace tools. Choose a tool '
        + 'from the current DSH catalog and supply exact arguments. DSH owns approval '
        + 'and execution. Never call OpenCode native read, glob, edit, bash or shell.',
      args: {
        name: { type: 'string', description: 'Exact current DSH tool name' },
        arguments: { type: 'object', description: 'Arguments matching the declared DSH tool schema', additionalProperties: true },
      },
      async execute(args, context) {
        const response = await fetch(origin + '/call', {
          method: 'POST', headers, redirect: 'error', signal: context.abort,
          body: JSON.stringify({ sessionID: context.sessionID, messageID: context.messageID,
            callID: context.callID, name: args.name, arguments: args.arguments }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'DSH bridge request rejected');
        return { title: 'DSH ' + args.name, output: JSON.stringify(result), metadata: { dshProxy: true } };
      },
    } },
    async 'tool.execute.before'({ tool }) {
      // Only the message proxy runs here. It has no file or process executor.
      if (tool !== 'dsh_call') throw new Error('DSH_STRUCTURED_NATIVE_TOOL_BLOCKED');
    },
    async 'experimental.chat.system.transform'({ sessionID }, output) {
      if (!sessionID) return;
      const response = await fetch(origin + '/context?sessionID=' + encodeURIComponent(sessionID), {
        headers, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('No active DSH context for this OpenCode session');
      const context = await response.json();
      // /message.system already contains the DSH instructions and the PTC SDK.
      // Do not duplicate them in this hook, especially for long PTC catalogs.
      const guidance = 'Current DSH tool catalog:\n' + JSON.stringify(context.tools)
        + '\n\n' + structuredToolGuidance(context.tools);
      // OpenCode holds the original array reference; merge in place to avoid
      // multiple system-role messages rejected by some compatible gateways.
      output.system.splice(0, output.system.length,
        [...output.system, guidance].filter(Boolean).join('\n\n'));
    },
  };
};

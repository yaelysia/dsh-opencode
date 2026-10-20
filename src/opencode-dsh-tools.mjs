import { writeFile } from 'node:fs/promises';

/** Managed child only. Uses OpenCode 1.19.3's plugin-tool JSON Schema
 * compatibility path without a second install or npm dependency. */
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
      description: 'Request one of the current DSH tools. DSH alone approves and executes it. '
        + 'Pass the exact declared tool name and arguments. Do not use OpenCode file or shell tools.',
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
      output.system.push('Use native dsh_call for tools; never print a textual tool envelope. '
        + 'OpenCode native tools are unavailable. Wait for the actual DSH result before continuing. '
        + 'DSH paths resolve in the DSH workspace, not the OpenCode runtime directory. '
        + 'Use dedicated DSH file tools rather than shell when they can complete the task.\n'
        + context.instructions + '\nCurrent DSH tool catalog:\n' + JSON.stringify(context.tools));
    },
  };
};

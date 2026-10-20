import { writeFile } from 'node:fs/promises';

// Loaded only into dsh-opencode's isolated, self-owned OpenCode process.
// The guard must register before the parent accepts a single model request.
export const DshNativeToolGuard = async () => {
  const marker = process.env.DSH_OPENCODE_GUARD_MARKER;
  const nonce = process.env.DSH_OPENCODE_GUARD_NONCE;
  if (!marker || !/^[a-f0-9]{64}$/.test(nonce ?? '')) {
    throw new Error('DSH guard requires an authenticated managed startup');
  }
  return {
    async config() {
      // Called after this hook object has been registered by OpenCode.
      await writeFile(marker, nonce, { mode: 0o600 });
    },
    async 'tool.execute.before'() {
      // Even when a compatibility read tool is advertised to a free model,
      // OpenCode is never allowed to execute it. DSH owns all tool execution.
      throw new Error('DSH_OPENCODE_NATIVE_TOOL_BLOCKED');
    },
  };
};

import { writeFile, appendFile } from 'node:fs/promises';

// Loaded only into dsh-opencode's isolated, self-owned OpenCode process.
// The guard must register before the parent accepts a single model request.
export const DshNativeToolGuard = async () => {
  const marker = process.env.DSH_OPENCODE_GUARD_MARKER;
  const nonce = process.env.DSH_OPENCODE_GUARD_NONCE;
  const audit = process.env.DSH_OPENCODE_GUARD_AUDIT;
  if (!marker || !/^[a-f0-9]{64}$/.test(nonce ?? '') || !audit) {
    throw new Error('DSH guard requires an authenticated managed startup');
  }
  return {
    async config() {
      // Called after this hook object has been registered by OpenCode.
      await writeFile(marker, nonce, { mode: 0o600 });
    },
    async 'tool.execute.before'(input) {
      // Durable proof is written before the hook denies execution. Do not
      // include tool arguments, file paths, or any user content.
      const { sessionID, callID, tool } = input ?? {};
      if (typeof sessionID === 'string' && typeof callID === 'string'
        && typeof tool === 'string') {
        await appendFile(audit, JSON.stringify({ nonce, sessionID, callID, tool }) + '\n',
          { mode: 0o600 });
      }
      throw new Error('DSH_OPENCODE_NATIVE_TOOL_BLOCKED');
    },
  };
};

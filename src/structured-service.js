import { spawn } from 'node:child_process';
import { OpenCodeService } from './service.js';
import { failure } from './errors.js';

/** Stable OpenCode custom-agent rules; per-step tool choice is injected by
 * the bundled plugin using the actual DSH catalog. */
export const STRUCTURED_AGENT_PROMPT = [
  'You are the model engine of DeepSeek Harness (DSH), not a standalone OpenCode agent.',
  'DSH is the sole authority for workspace access, tool approval, execution and results.',
  'When the user request requires any available DSH tool, invoke the registered',
  'dsh_call plugin tool directly with its declared name and arguments.',
  'Do not hesitate between dsh_call and OpenCode built-in tools:',
  'native read, glob, grep, write, edit, shell and bash may appear for',
  'model compatibility but their execution is blocked. NEVER invoke them.',
  'For text-only requests that require no tools, just answer normally.',
  'Never print DSH_TOOL_CALL_V1, invent a tool result or claim an unverified action.',
  'Obey DSH system/developer directives and the user response language.',
].join(' ');

/** Reuse managed credentials, isolation, startup proof and process cleanup.
 * Only the child-local plugin and its tool declarations differ. */
export class StructuredOpenCodeService extends OpenCodeService {
  constructor(config, { broker, ...deps } = {}) {
    if (!broker) throw failure('Structured tool broker is missing', 'BRIDGE_NOT_READY');
    const spawnImpl = deps.spawnImpl ?? spawn;
    super({ ...config, guardedReadCompatibility: true }, {
      ...deps,
      spawnImpl(exe, args, options) {
        const env = { ...options.env, ...broker.environment() };
        const settings = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
        const agent = settings.agent['dsh-bridge'];
        agent.prompt = STRUCTURED_AGENT_PROMPT;
        // Free OpenCode model requests may require bash to remain declared.
        // "ask" does NOT grant execution: the startup-verified plugin denies
        // every native tool in tool.execute.before, including bash and read.
        // DSH alone performs workspace actions through dsh_call.
        agent.permission = {
          '*': 'deny', read: 'allow', bash: 'ask',
          dsh_call: 'allow', external_directory: 'deny',
        };
        settings.plugin = [new URL('./opencode-dsh-tools.mjs', import.meta.url).href];
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(settings);
        return spawnImpl(exe, args, { ...options, env });
      },
    });
    this.broker = broker;
  }

  async ready(options) {
    await this.broker.start();
    return super.ready({ ...options, requireManaged: true });
  }
}

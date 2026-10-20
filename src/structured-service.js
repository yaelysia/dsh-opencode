import { spawn } from 'node:child_process';
import { OpenCodeService } from './service.js';
import { failure } from './errors.js';

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
        agent.prompt = 'You are the model component of DeepSeek Harness. Use dsh_call for DSH tools. '
          + 'Only DSH may approve and execute actions. Do not use OpenCode native tools.';
        agent.permission = { '*': 'deny', read: 'allow', dsh_call: 'allow', external_directory: 'deny' };
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

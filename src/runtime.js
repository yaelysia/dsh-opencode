import { createAdapter } from './bridge.js';
import { OpenCodeService } from './service.js';
import { StructuredToolBroker } from './structured-broker.js';
import { StructuredOpenCodeService } from './structured-service.js';
import { createStructuredAdapter } from './structured-adapter.js';

/** One DSH plugin owns its adapter, transport listener and OpenCode child.
 * Mode selection never silently falls back to legacy tools after an error. */
export function createPluginRuntime(config, deps = {}) {
  const structured = config.structuredToolsEnabled === true;
  const options = structured ? { ...config, autoStart: true, strictOwnedServer: true } : config;
  const broker = structured ? new StructuredToolBroker() : null;
  const supervisor = structured
    ? new StructuredOpenCodeService(options, { ...deps, broker })
    : new OpenCodeService(options, deps);
  const settings = { ...options,
    passwordProvider: () => supervisor.passwordForClient(),
    verifyNativeDenials: parts => supervisor.verifiedNativeDenials(parts),
    ensureService: ({ requireManaged } = {}) => supervisor.ready({
      requireManaged: options.strictOwnedServer !== false || requireManaged === true
        || options.guardedReadCompatibility === true,
    }),
  };
  const adapter = structured ? createStructuredAdapter(settings, broker, deps.fetchImpl)
    : createAdapter(settings, deps.fetchImpl);
  return {
    adapter, supervisor,
    ready: () => supervisor.ready(),
    async dispose() {
      // Release approval waiters and abort the retained model request before
      // ending its child; callbacks must never outlive the DSH plugin.
      try { await adapter.runtime?.dispose(); }
      finally { await supervisor.dispose(); }
    },
  };
}

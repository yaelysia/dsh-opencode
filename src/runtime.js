import { createAdapter } from './bridge.js';
import { OpenCodeService } from './service.js';
import { StructuredToolBroker } from './structured-broker.js';
import { StructuredOpenCodeService } from './structured-service.js';
import { createStructuredAdapter } from './structured-adapter.js';
import { DiagnosticHub } from './diagnostics.js';

/** One DSH plugin owns adapter, transport listener, local diagnostics and
 * OpenCode child. Diagnostics are passive and never invoke a model/tool. */
export function createPluginRuntime(config, deps = {}) {
  const structured = config.structuredToolsEnabled === true;
  const options = structured ? { ...config, autoStart: true, strictOwnedServer: true } : config;
  let diagnostics;
  const diagnosticEvent = (category, code, details, level) =>
    diagnostics?.record(category, code, details, level);
  const broker = structured ? new StructuredToolBroker() : null;
  const supervisor = structured
    ? new StructuredOpenCodeService(options, { ...deps, broker, diagnosticEvent })
    : new OpenCodeService(options, { ...deps, diagnosticEvent });
  diagnostics = new DiagnosticHub({
    root: supervisor.runtimeRoot,
    port: config.diagnosticsPort ?? 4097,
    enabled: structured && config.diagnosticsEnabled !== false,
    logger: deps.logger,
  });
  if (broker) broker.diagnosticEvent = diagnosticEvent;
  const settings = { ...options,
    ...(structured ? { sessionJournalRoot: supervisor.runtimeRoot } : {}),
    diagnosticEvent,
    passwordProvider: () => supervisor.passwordForClient(),
    verifyNativeDenials: parts => supervisor.verifiedNativeDenials(parts),
    serviceGenerationProvider: () => supervisor.generation,
    reportLocalFailure: () => supervisor.reportLocalFailure(),
    ensureService: ({ requireManaged } = {}) => supervisor.ready({
      requireManaged: options.strictOwnedServer !== false || requireManaged === true
        || options.guardedReadCompatibility === true,
    }),
  };
  const adapter = structured ? createStructuredAdapter(settings, broker, deps.fetchImpl)
    : createAdapter(settings, deps.fetchImpl);
  supervisor.onBeforeRestart = () => adapter.runtime?.onServiceRestart();
  return {
    adapter, supervisor, diagnostics,
    async ready() {
      await diagnostics.start();
      return supervisor.ready();
    },
    async dispose() {
      // Retained tool callbacks stop before the owned service. Diagnostics are
      // closed last so cleanup/deletion failures can be recorded.
      try { await adapter.runtime?.dispose(); }
      finally {
        try { await supervisor.dispose(); }
        finally { await diagnostics.dispose(); }
      }
    },
  };
}

# Structured OpenCode handoff — implementation checkpoint

Base recovered from PR #1: `3856c7a86eba0df6a6720ddaac2a9718f46943e3`.
The uncommitted work reported in earlier screenshots was not present in that Git tree.
This change adds reproducible tests and the DSH configuration/lifecycle wiring on top of the recovered five-module prototype.

## Components and invariants

- `runtime.js`: single DSH plugin chooses legacy or structured mode; structured mode always owns the local server. No automatic fallback after errors.
- `structured-service.js`: reuses existing loopback server startup, random Basic Auth, isolated config, plugin-ready proof and owned-child cleanup. Injects the bundled OpenCode plugin without installing a second user-facing plugin.
- `opencode-dsh-tools.mjs`: native `dsh_call` has a structured `name` / `arguments` schema. Forwards to a per-process authenticated callback; it contains no file/shell executor. All other native tools are blocked before execution.
- `structured-broker.js`: private loopback rendezvous, per-session tool catalog, one-time callback IDs, bounded pending calls. Only the DSH adapter has the in-process method that supplies execution results; HTTP cannot approve or settle a request.
- `structured-adapter.js`: keeps one OpenCode `/message` request across DSH tool steps. The callback yields `tool-call` immediately; the next DSH call supplies matching `source.callId` result and releases the callback. No extra POST on resume. Timers separate model generation from approval wait.
- `structured-events.js`: maps typed reasoning/text independently. Never classifies English as reasoning heuristically.
- `index.js` / `lib/client.js`: volatile `structuredToolsEnabled=false`; visible mode switch, save/reset, automatic backend management. Saving still needs a Desktop restart.

The OpenCode context may advertise native `read` for gateway compatibility, but the plugin refuses its execution. Native errors are not translated into DSH tool calls by this new channel. DSH alone owns workspace paths, tool schema validation, approvals, actual execution and refusal content.

## Tests and reproduction

- `npm test`: includes structured handoff/resume, two sessions, replay rejection, timeout/cancel, runtime ownership and typed output tests.
- `OPENCODE_TEST_EXE=/path/to/opencode node --test integration/structured-plugin-poc.mjs`: real OpenCode 1.19.3, local mock model, a deterministic DSH-side tool execution harness. Covers `glob → read → edit`, denial at edit, cancellation during approval and two simultaneous sessions.
- CI sets `DSH_VALIDATE_ASSEMBLER=1` and installs the pinned published DSH 0.2.1-rc.2 dependencies to also assemble the actual returned blocks and construct real host tool results.
- No online/free model requests in automated tests. Test-only environment disables optional startup fetches and uses offline npm resolution; production credentials/provider configuration are unchanged.

## Known limits / next acceptance

- Real `deepseek-v4.1-flash-free` gateway eligibility is not proven by a local model emulator. Never claim a live gateway or Desktop UI approval test passed from CI alone.
- Callback lifetime across an actual Desktop stop/retry must be validated. A callback expires after 10 minutes if DSH never returns a tool result. No persistence/resumption across application restart: pending actions fail closed and are never replayed.
- DSH tool catalog names can change per step; queued calls are checked again before dispatch. DSH performs full argument schema validation. Arbitrary multimodal tool result attachments are not fully modeled by this JSON transport.
- Tool round-trip metadata/usage aggregation is not a billing reconciliation feature. The final OpenCode response supplies available token usage.
- The original PR remains Draft pending Desktop + actual model acceptance. This feature does not authorize native filesystem/shell access or any bypass of free-tier policies.

## User path

Install this DSH Git plugin → open its detail/config page → enable “结构化工具通道（实验）” → save → restart DSH.
Backend plugin files, loopback listener, credentials, runtime config and OpenCode process are automatic. The official CLI must already be installed. No manual OpenCode commands, plugin installation, or YAML changes are required.

## 2026-10-21 — Post-tool upstream 429 and DSH retry boundary

Real DSH Desktop session `session-5795e060-cad3-4e53-8ed6-ef279ab83748`:
- `dsh_call(glob, {"pattern":"**/*.txt"})` reached the host, DSH returned `text.txt`.
- The original retained OpenCode POST then failed during the next model inference with HTTP 429 and `Upstream request failed: Endpoint is unavailable`.
- DSH's standard retry policy includes `RATE_LIMIT`; a retry of the **same tool-result step** could not recover the closed OpenCode POST and replaced the useful upstream error with `TOOL_RESULT_MISMATCH`.

Guardrail: after any tool handoff, retryable model failures (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`) are wrapped as non-retryable `TOOL_CONTINUATION_FAILED`, preserving the original failure code, message and status. A bounded in-memory terminal error record keyed to DSH session/model/purpose and the last host tool call retains the correct error for accidental duplicate result delivery. A new user message starts a new cycle. No tool execution or HTTP model POST is repeated for a stale result.

Tests:
- Unit: mock OpenCode `dsh_call` → real private broker callback → DSH tool result → upstream 429; assert non-retryable error and zero duplicate POSTs. Before handoff, upstream 429 remains `RATE_LIMIT`.
- Integration: published DSH `BlockAssembler` and `createToolResultMessage` exercise the same continuation failure.
- This is not evidence of the cloud free gateway's reliability; real `deepseek-v4.1-flash-free` may still return HTTP 429 after tools.

Follow-up: investigate provider-side post-tool 429 independently rather than replaying already executed DSH actions or bypassing provider limitations.

## 2026-10-21 — Default `dsh_call` guidance with native/PTC detection

Model-visible OpenCode built-in `read` is retained for free-model compatibility; execution remains prohibited by the existing backend plugin. Real Desktop users observed occasional hesitation or an attempted native tool before models corrected themselves and invoked `dsh_call`.

This change strengthens the *existing* isolated `dsh-bridge` custom Agent prompt (without changing permissions) and adds reusable per-turn `structuredToolGuidance(tools)` to the bundled OpenCode plugin's `experimental.chat.system.transform` hook.

- When an environmental action is required, the only valid gateway is the registered OpenCode plugin tool `dsh_call({name,arguments})`. Never attempt built-in file/shell tools first, print legacy text tool JSON, or declare success before a DSH result.
- DSH native: `name` is one of the currently declared DSH tool names. Do not invent `run_code`.
- DSH PTC: the visible catalog contains only `run_code`; proxy `run_code` via `dsh_call` with `code` and `description`; the program calls DSH-generated SDK bindings. No separate OpenCode PTC runtime or shell tools are introduced.
- With no DSH tools, normal text completion is allowed, without forced tool calls.
- Existing DSH response-language directives remain authoritative. Per-turn tool catalog and instructions still originate from DSH; the OpenCode agent prompt owns only static safety identity.
- PTC is an optional *DSH preset*, not an automatically selected plugin mode. It is most attractive for multi-step/batch tool use, not necessarily a single file edit.

Regression tests exercise static/dynamic prompt decisions, authenticated session-scoped plugin prompt injection, unchanged native-tool guard, and a published DSH BlockAssembler `run_code` proxy handoff with continuation of one OpenCode POST. A real Desktop PTC workload is still a separate manual performance/compatibility check. No new user-facing DSH setting is needed.

## 2026-10-21 — Consolidate OpenCode system messages for PTC compatibility (alpha.16)

In the managed structured adapter, the OpenCode `/message` payload already supplies
the current DSH system/developer instructions, including the generated PTC SDK.
Previously the bundled plugin's `experimental.chat.system.transform` hook
appended the same instructions a second time via `output.system.push(...)`.
This doubled PTC SDK text and produced multiple `system` messages, which some
OpenAI-compatible backends reject.

The plugin now appends only the current tool catalog and the native/PTC routing
guidance, **in place** into one assembled system string. DSH instructions still
enter through `/message.system` at their original authority. Neither tool
permissions nor DSH sandboxing change. Tests cover single-system injection,
PTC SDK marker uniqueness and a real OpenCode 1.19.3 mock-provider PTC
`dsh_call(run_code)` round-trip (outer bridge only). Real Desktop PTC execution
of generated TypeScript is not claimed by this test.

The separate Windows `pwsh` ACL / ConstrainedLanguage / cwd issue concerns
DSH's shell sandbox and should be reproduced using a native DSH model before
changing this adapter or a user's filesystem ACLs. No automatic privilege
escalation or sandbox bypass is permitted.

## 2026-10-21 — Free-tier permission catalog compatibility (alpha.17)

Some OpenCode free-model requests fail with `CLIENT_RESTRICTED` when a custom
agent's deny-first permission configuration removes `bash` or `read`
from the model-visible tool catalog. This is documented in upstream
OpenCode issues #49433 and #50627; it is not proof that the hosted
service accepts third-party clients, nor a blanket authorization to use it.

The managed structured `dsh-bridge` agent now declares `bash: ask`
alongside its existing `read: allow` and `dsh_call: allow`. The global
deny-first policy is unchanged. The startup-verified
`tool.execute.before` plugin rejects every native tool, including `bash`,
before the built-in executor or approval logic executes. Only `dsh_call`
can actually request host operations, where DSH remains the approval and
execution authority. No gateway header spoofing or credential changes.

A real official OpenCode 1.19.3 mock-model integration test requests a
native bash command with `bash: ask` and checks (Windows/Linux) that:
the model receives a bash declaration, the registered plugin denies it
before execution or permission hang, the model continues after the denial,
and the adapter does not forward that native intent as a DSH tool call.
The native/structured DSH tool loops and other CI checks remain active.
These are **offline** transport and security tests; live free gateway
eligibility must be tested by the Desktop user. A continuing
`CLIENT_RESTRICTED` response must be surfaced without bypass or retries.

## 2026-10-21 — Pinned official OpenCode CLI (alpha.18)

A second Windows machine lost its manually installed CLI and the old
hardcoded default yielded SERVER_NOT_INSTALLED. The plugin now depends
on opencode-ai@1.19.3 and locates the official platform binary directly
through that package's optional dependencies, including when its install
script is disabled by the package manager. The native executable is
version-checked and pinned independently of global/Desktop OpenCode.

Manual opencodeExecutable/OPENCODE_EXECUTABLE paths retain priority.
Missing or inconsistent bundled dependencies fail closed; no runtime
download or unverified fallback to a different OpenCode installation.
Windows/Linux offline binary and structured tool integration tests pass.

An earlier Windows PTC/pwsh error was traced by the user to directory ACL
conflicts with the DSH Low Integrity sandbox. Selecting an alternative
DSH installation directory resolved it; this is independent of the
plugin tool call boundary. No ACL mutations or sandbox bypass are made.

## 2026-10-21 — Alpha.20 context and owned Session lifecycle

Built on alpha.19 Session reuse. The DSH-side adapter alone owns model-budget checks,
OpenCode native /summarize orchestration and post-turn Session retirement. The
OpenCode-side plugin keeps existing dsh_call execution isolation unchanged.
Model limits are read from /provider, not hard-coded; estimates are a preflight
signal, not authoritative tokenizer counts. No DSH history rewriting/truncation.
A compaction request temporarily registers a **zero-tool** broker catalog;
its internal assistant events must not be rendered as DSH replies.
A small process-scoped journal of opaque owned Session IDs supports
conservative orphan cleanup after restarts. Only idle/owned Sessions are
deleted; pending tool handoffs are never candidates. Failed cleanup retains
the journal entry. Real gateway compatibility requires field acceptance.

## 2026-10-22 — DSH Desktop pnpm install failure, native binary packaging fix

A DSH Desktop Git install of alpha.20 failed at `node_modules/opencode-ai postinstall$ node ./postinstall.mjs`
with `It seems your package manager failed to install the right opencode CLI package`
and `ELIFECYCLE exit code 1`. This is the official `opencode-ai@1.19.3`
wrapper attempting to resolve/copy an optional OS-native binary; if resolution
or its npm-based fallback cannot produce a usable binary, the *entire plugin
installation* fails before startup. Previous pnpm CI always used
`--ignore-scripts`, so it missed this failure class.

Replaced `opencode-ai` with **exactly pinned official platform-specific
`opencode-{windows,linux,darwin}-*` optional dependencies** at version
`1.19.3`. `bundledExecutable()` resolves them directly from the plugin
without wrapper postinstall, runtime downloads, shell shims, global PATH, or
manual installations. Unsupported/missing/mismatched binaries still fail
closed with explicit errors. DSH's only tool executor remains DSH.

Regression coverage:
- Windows/Linux packed-plugin pnpm install with both regular lifecycle scripts
  and `--ignore-scripts`, verifying the binary launches and `opencode-ai`
  wrapper is absent.
- Windows/Linux `pnpm add git+https://github.com/yaelysia/dsh-opencode.git#<SHA>`
  matching DSH's real Git install method with scripts enabled.
- Existing pinned 1.19.3 full bridge/guard/compaction integration and Node
  22/24 checks are retained. Desktop installation itself still requires
  user-side field acceptance.

## 2026-10-22 — Alpha.21 idle retention and managed server recovery

- New DSH UI field `sessionIdleHours` (integer 1–2160, default 168 = seven days); 32-idle-session LRU cap remains independent. The binding is **in memory only**; complete Desktop restart still discards the reuse mapping and rebuilds from DSH authoritative messages.
- Owned OpenCode processes receive a low-frequency loopback health probe (30s), a second confirming probe on failure, and a serialized, rate-limited restart. Unmanaged processes are never killed. The restarted child must present the isolated `dsh-bridge` and fresh native tool guard marker before any subsequent model call.
- On replacement, the DSH-side adapter aborts retained model requests and all pending `dsh_call` bridges, invalidates reusable Session mappings and model budget cache. Already delivered tools remain non-replayable, with their terminal errors preserved for the original call ID. Legacy adapter clears upstream incremental cache on child generation change.
- Two restart attempts per 60s maximum. Upstream free-tier 429/restrictions are provider responses, not local liveness failures. Current steps can fail and are **not** transparently retried; next user turns recover against DSH history.

## 2026-10-22 — Alpha.22 read-only diagnostics UI

- Host `DiagnosticHub` records strict allowlisted operational metadata only and rotates
  bounded JSONL files; never serialize full user messages, tool JSON or credentials.
- `conversation.input.right` is a public DSH slot **before the model selector**;
  `sidebar.right.pane.tab` is the public keyed body for a registered custom
  `sidebarRightTabs` kind. No DSH core modifications or DOM monkey-patching.
- The composed, read-only UI uses a local 127.0.0.1 diagnostic server on configurable
  port 4097, separate from the Basic Auth OpenCode model endpoint.
  Cross-origin API reads are rejected; only same-origin embedded iframe code can
  access redacted snapshots/events with a diagnostic-specific header.
- The badge reports approximate last-known context (not an exact tokenizer),
  compressing state, and unknown limits honestly. The Sidebar can filter session,
  category, level and export redacted JSONL. A port collision does not fail the model.
- Included health/process, Session GC, context and tool handoff event categories.
  A full DSH Desktop smoke remains necessary for iframe/CSP and Sidebar rendering.

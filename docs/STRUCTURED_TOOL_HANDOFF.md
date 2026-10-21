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

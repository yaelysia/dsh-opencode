import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClient() {
  let registered;
  runInNewContext(bundle, {
    window: { __ModuleLoader__: {
      load(value) { registered = value; },
    } },
  }, { filename: 'lib/client.js', timeout: 5000 });
  assert.equal(registered?.id, 'dsh-opencode');
  const created = [];
  const React = { createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } };
  } };
  const factoryStubs = {
    SettingsForm: function SettingsForm() {},
    SettingsValueField: function SettingsValueField() {},
    settingsTextField(field) {
      return { field, format: value => String(value || ''), parse: text => ({ kind: 'set', value: text }) };
    },
    SettingsFormModel: class FakeSettingsFormModel {
      constructor(scope, specs) {
        this.scope = scope;
        this.specs = Object.fromEntries(specs.map(spec => [spec.field, spec]));
        this.staged = new Map();
        this.saved = [];
        created.push(this);
      }
      bind(project) { return { getSnapshot: project }; }
      shell() { return { available: true, writable: true,
        dirty: this.staged.size > 0, invalid: false, saving: false, failed: false }; }
      field(field) {
        const spec = this.specs[field];
        const text = this.staged.get(field)?.text ?? spec.format(this.scope.getSnapshot().value[field]);
        return { text, overridden: this.staged.has(field), invalid: spec.parse(text) === undefined };
      }
      actions() {
        return {
          edit: (field, text) => { this.staged.set(field, { text }); },
          resetField: field => { this.staged.delete(field); },
          discard: () => { this.staged.clear(); },
          save: () => {
            for (const [field, { text }] of this.staged) {
              const write = this.specs[field].parse(text);
              this.saved.push({ field, ...write });
            }
          },
        };
      }
      dispose() { this.disposed = true; }
    },
  };
  const exports = registered.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return factoryStubs;
    throw new Error('Unexpected external module: ' + name);
  });
  return { exports, registered, created, React, stubs: factoryStubs };
}

test('the installed bundle ships a prebuilt DSH browser half without prepare scripts', () => {
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.files.includes('lib/client.js'));
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
  ]);
  assert.equal(manifest.scripts?.prepare, undefined);
});

test('the DSH client factory contributes settings directly to the bundle detail page', () => {
  const { exports, created } = loadClient();
  assert.deepEqual([...exports.inject],
    ['slots', 'locale', 'configForms', 'sidebarRight', 'sidebarRightTabs']);
  const effects = [];
  let registration, dictionaries, watched;
  const scope = { getSnapshot: () => ({ value: {
    guardedReadCompatibility: false, ssePreviewEnabled: false, models: ['test-model'],
  } }) };
  const ctx = {
    effect(fn) { effects.push(fn()); },
    locale: {
      bind() { return key => dictionaries?.zh[key] || key; },
      register(ns, words) { assert.equal(ns, 'dsh-opencode.settings'); dictionaries = words; return () => {}; },
    },
    configForms: {
      get(id) { assert.equal(id, 'opencode-serve'); return scope; },
      whileServed(ids, register) {
        assert.deepEqual([...ids], ['opencode-serve']);
        watched = true;
        return register();
      },
    },
    slots: {
      inject(name, register) {
        assert.equal(name, 'plugins.bundle.config');
        return register();
      },
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  assert.equal(watched, true);
  assert.equal(registration.options.key, 'dsh-opencode');
  assert.equal(registration.options.locale, 'dsh-opencode.settings');
  assert.equal(registration.options.name, 'plugins.bundle.config');
  assert.equal(dictionaries.zh.title, 'OpenCode 模型桥接');
  const face = registration.options.inject();
  const model = created[0];
  assert.deepEqual(Object.keys(model.specs).sort(), [
    'structuredToolsEnabled','guardedReadCompatibility','ssePreviewEnabled','toolBridgeEnabled',
    'localTitles','strictOwnedServer','autoStart','autoStartDirect',
    'endpoint','opencodeExecutable','runtimeRoot','username','passwordEnv',
    'timeoutMs','autoStartTimeoutMs','sessionIdleHours','diagnosticsPort','diagnosticsEnabled','models',
  ].sort());
  face.edit('guardedReadCompatibility', 'true');
  face.edit('ssePreviewEnabled', 'false');
  face.save();
  assert.ok(model.saved.some(x => x.field === 'guardedReadCompatibility' && x.value === true));
  assert.ok(model.saved.some(x => x.field === 'ssePreviewEnabled' && x.value === false));
  const ui = registration.component({ view: 'page',
    t: key => dictionaries.zh[key],
    useOpencodeSettings: select => select(face.hooks.opencodeSettings.getSnapshot()),
    ...face,
  });
  assert.ok(ui);
  assert.ok(ui.props.children?.length, 'the settings form receives actual input sections');
  assert.match(dictionaries.zh.label_sessionIdleHours, /空闲保留/);
  assert.match(dictionaries.zh.hint_sessionIdleHours, /7 天/);
  const nodes = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    visit(node.props?.children);
  };
  visit(ui);
  const resetAll = nodes.find(node => node.type === 'button'
    && node.props?.children?.includes(dictionaries.zh.resetAll));
  assert.ok(resetAll, 'the page must offer an in-UI way to clean saved overrides');
  const resetCalls = [];
  const pageWithReset = registration.component({ view: 'page',
    t: key => dictionaries.zh[key],
    useOpencodeSettings: select => select(face.hooks.opencodeSettings.getSnapshot()),
    ...face, resetField: field => resetCalls.push(field),
  });
  const updatedNodes = [];
  const collect = node => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    updatedNodes.push(node);
    collect(node.props?.children);
  };
  collect(pageWithReset);
  updatedNodes.find(node => node.type === 'button'
    && node.props?.children?.includes(dictionaries.zh.resetAll)).props.onClick();
  assert.deepEqual(resetCalls.sort(), Object.keys(model.specs).sort());
  const summary = registration.component({ view: 'summary', t: key => dictionaries.en[key],
    useOpencodeSettings: select => select(face.hooks.opencodeSettings.getSnapshot()), ...face });
  assert.equal(summary, dictionaries.en.description);
  for(const dispose of effects.reverse()) if(typeof dispose==='function') dispose();
  assert.equal(model.disposed, true);
});

test('form field parsers reject malformed values before persisting', () => {
  const { exports, created } = loadClient();
  const ctx = {
    effect(fn) { fn(); },
    locale: { bind: () => x => x, register: () => () => {} },
    configForms: { get: () => ({ getSnapshot: () => ({ value: {} }) }),
      whileServed: (_names, register) => register() },
    slots: { inject: (_slot, register) => register(), register: () => () => {} },
  };
  exports.apply(ctx);
  const specs = created[0].specs;
  assert.deepEqual(JSON.parse(JSON.stringify(specs.guardedReadCompatibility.parse('true'))), { kind: 'set', value: true });
  assert.equal(specs.guardedReadCompatibility.parse('maybe'), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(specs.timeoutMs.parse(''))), { kind: 'clear' });
  assert.equal(specs.timeoutMs.parse('-3'), undefined);
  assert.equal(specs.timeoutMs.parse('1.5'), undefined);
  assert.equal(specs.timeoutMs.parse('Infinity'), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(specs.sessionIdleHours.parse('168'))),
    { kind: 'set', value: 168 });
  assert.equal(specs.sessionIdleHours.parse('1.5'), undefined);
  assert.equal(specs.sessionIdleHours.parse('-1'), undefined);
  assert.equal(specs.sessionIdleHours.parse('2161'), undefined);
  assert.ok(specs.sessionIdleHours.parse('2160'));
  assert.equal(specs.diagnosticsPort.parse('1023'), undefined);
  assert.equal(specs.diagnosticsPort.parse('65536'), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(specs.diagnosticsPort.parse('4097'))),
    { kind: 'set', value: 4097 });
  assert.deepEqual(JSON.parse(JSON.stringify(specs.diagnosticsEnabled.parse('true'))),
    { kind: 'set', value: true });
  assert.deepEqual(JSON.parse(JSON.stringify(specs.sessionIdleHours.parse(''))),
    { kind: 'clear' });
  assert.deepEqual(JSON.parse(JSON.stringify(specs.models.parse('model-a\nmodel-b'))), { kind: 'set', value: ['model-a','model-b'] });
  assert.equal(specs.models.parse('model-a\nmodel-a'), undefined);
});

test('configuration page blocks an invalid guarded-read and auto-start combination', () => {
  const { exports, created } = loadClient();
  let registration;
  const ctx = {
    effect(fn) { fn(); },
    locale: { bind: () => x => x, register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: { guardedReadCompatibility: false, autoStart: true } }) }),
      whileServed: (_ids, register) => register(),
    },
    slots: { inject: (_slot, register) => register(), register: opts => {
      registration = opts; return () => {};
    } },
  };
  exports.apply(ctx);
  const face = registration.inject();
  face.edit('guardedReadCompatibility', 'true');
  face.edit('autoStart', 'false');
  let state = face.hooks.opencodeSettings.getSnapshot();
  assert.equal(state.guardConflict, true);
  assert.equal(state.invalid, true);
  face.edit('autoStart', 'true');
  state = face.hooks.opencodeSettings.getSnapshot();
  assert.equal(state.guardConflict, false);
  assert.equal(state.invalid, false);
});

test('diagnostic view extends model-adjacent composer and custom Sidebar tab without replacement', () => {
  const { exports } = loadClient();
  const registered = [], kinds = [], opened = [];
  const ctx = {
    effect(fn) { fn(); },
    locale: { bind: () => key => key, register: () => () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ value: { diagnosticsEnabled: true, structuredToolsEnabled: true, diagnosticsPort: 4107 } }) }),
      whileServed: (_ids, register) => register(),
    },
    sidebarRightTabs: { register(definition) { kinds.push(definition); return () => {}; } },
    sidebarRight: { openTab(kind) { opened.push(kind); } },
    slots: { inject(name, attach) { return attach(); },
      register(opts, component) { registered.push({ opts, component }); return () => {}; } },
  };
  exports.apply(ctx);
  assert.equal(kinds.length, 1);
  assert.equal(kinds[0].kind, 'dsh-opencode-diagnostics');
  const right = registered.find(x => x.opts.name === 'conversation.input.right');
  const pane = registered.find(x => x.opts.name === 'sidebar.right.pane.tab');
  assert.ok(right);
  assert.ok(pane);
  assert.equal(right.opts.id, 'dsh-opencode-context');
  assert.equal(pane.opts.key, 'dsh-opencode/diagnostics');
  const injected = right.opts.inject('some-dsh-session');
  assert.equal(injected.port, 4107);
  const badge = right.component(injected);
  const children = badge.props.children.flat();
  const iframe = children.find(item => item.type === 'iframe');
  assert.equal(iframe.props.src,
    'http://127.0.0.1:4107/v1/badge?sid=some-dsh-session');
  assert.equal(iframe.props.sandbox, 'allow-scripts allow-same-origin');
  const open = children.find(item => item.type === 'button');
  open.props.onClick();
  assert.deepEqual(opened, ['dsh-opencode-diagnostics']);
  const panelInjected = pane.opts.inject('same-session');
  assert.equal(panelInjected.sessionId, 'same-session');
  assert.equal(pane.component(panelInjected).props.src,
    'http://127.0.0.1:4107/v1/page?sid=same-session');
});

test('diagnostic UI does not mount in legacy mode or when switched off', () => {
  const { exports } = loadClient();
  for (const settings of [
    { diagnosticsEnabled: false, structuredToolsEnabled: true },
    { diagnosticsEnabled: true, structuredToolsEnabled: false },
  ]) {
    const registered = [];
    exports.apply({
      effect(fn) { fn(); },
      locale: { bind: () => key => key, register: () => () => {} },
      configForms: {
        get: () => ({ getSnapshot: () => ({ value: settings }) }),
        whileServed: (_ids, register) => register(),
      },
      sidebarRightTabs: { register(definition) { registered.push(definition); return () => {}; } },
      sidebarRight: { openTab() {} },
      slots: { inject(_name, attach) { return attach(); },
        register(opts) { registered.push(opts); return () => {}; } },
    });
    assert.equal(registered.some(x => x.name === 'conversation.input.right'), false);
    assert.equal(registered.some(x => x.kind === 'dsh-opencode-diagnostics'), false);
  }
});

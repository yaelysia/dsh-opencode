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
  ]);
  assert.equal(manifest.scripts?.prepare, undefined);
});

test('the DSH client factory contributes a settings page to the installed plugin row', () => {
  const { exports, created } = loadClient();
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'configForms']);
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
        assert.equal(name, 'plugins.row.config');
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
  assert.equal(registration.options.key, 'dsh-opencode#opencode-serve');
  assert.equal(registration.options.locale, 'dsh-opencode.settings');
  assert.equal(registration.options.name, 'plugins.row.config');
  assert.equal(registration.options.label(), 'OpenCode 模型桥接');
  const face = registration.options.inject();
  const model = created[0];
  assert.deepEqual(Object.keys(model.specs).sort(), [
    'guardedReadCompatibility','ssePreviewEnabled','toolBridgeEnabled',
    'localTitles','strictOwnedServer','autoStart','autoStartDirect',
    'endpoint','opencodeExecutable','runtimeRoot','username','passwordEnv',
    'timeoutMs','autoStartTimeoutMs','models',
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
  assert.deepEqual(specs.guardedReadCompatibility.parse('true'), { kind: 'set', value: true });
  assert.equal(specs.guardedReadCompatibility.parse('maybe'), undefined);
  assert.deepEqual(specs.timeoutMs.parse(''), { kind: 'clear' });
  assert.equal(specs.timeoutMs.parse('-3'), undefined);
  assert.equal(specs.timeoutMs.parse('1.5'), undefined);
  assert.equal(specs.timeoutMs.parse('Infinity'), undefined);
  assert.deepEqual(specs.models.parse('model-a\nmodel-b'), { kind: 'set', value: ['model-a','model-b'] });
  assert.equal(specs.models.parse('model-a\nmodel-a'), undefined);
});

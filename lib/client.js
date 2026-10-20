/*
 * Browser half of dsh-opencode. This hand-authored lazy-CJS factory follows
 * DSH 0.2.1's __ModuleLoader__.load protocol; it ships prebuilt with the
 * Git package (no npm prepare/build hook or extra runtime server).
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode',
  factory(require) {
    const React = require('react');
    const {
      SettingsForm, SettingsValueField, SettingsFormModel, settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const NS = 'dsh-opencode.settings';
    const ENTRY = 'opencode-serve';
    const BUNDLE = 'dsh-opencode';

    const BOOLEAN = [
      'guardedReadCompatibility', 'ssePreviewEnabled', 'toolBridgeEnabled',
      'localTitles', 'strictOwnedServer', 'autoStart', 'autoStartDirect',
    ];
    const TEXT = ['endpoint', 'opencodeExecutable', 'runtimeRoot', 'username', 'passwordEnv'];
    const NUMBER = ['timeoutMs', 'autoStartTimeoutMs'];
    const LIST = 'models';
    const FIELDS = [...BOOLEAN, ...TEXT, ...NUMBER, LIST];
    const BOOLEAN_DEFAULT = {
      guardedReadCompatibility: false, ssePreviewEnabled: false,
      toolBridgeEnabled: true, localTitles: true, strictOwnedServer: true,
      autoStart: true, autoStartDirect: true,
    };
    const zh = {
      title: 'OpenCode 模型桥接',
      description: '配置 OpenCode 本地服务、模型和 DSH 工具边界。',
      restart: '保存后需要完整重启 DSH Desktop，新的服务、模型和安全配置才会生效。',
      unavailable: 'OpenCode 插件尚未载入，配置暂不可用。',
      readOnly: '当前 DSH 配置为只读。',
      saveFailed: '未能保存设置，请检查输入和配置版本后重试。',
      save: '保存设置', saving: '保存中…', reset: '恢复默认', overridden: '已覆盖',
      invalid: '请输入有效值。', safety: '模型与工具', service: '本地服务', advanced: '高级配置',
      listHint: '每行一个 OpenCode 模型 ID，也可用逗号分隔。',
      label_guardedReadCompatibility: '受保护的 read 兼容模式',
      hint_guardedReadCompatibility: '实验功能：向免费模型声明 read 可用，但由已验证的拦截插件阻止 OpenCode 原生工具执行。',
      label_ssePreviewEnabled: 'SSE 流式输出预览',
      hint_ssePreviewEnabled: '默认关闭；仅在 OpenCode 服务支持事件流时增量显示。工具请求仍需完整校验。',
      label_toolBridgeEnabled: 'DSH 工具桥接',
      hint_toolBridgeEnabled: '模型通过实验性文本协议向 DSH 请求工具，执行与审批仍由 DSH 负责。',
      label_localTitles: '本地生成会话标题',
      hint_localTitles: '直接使用用户消息生成简短标题，不额外请求模型。',
      label_strictOwnedServer: '仅使用插件托管的服务',
      hint_strictOwnedServer: '保持开启以避免接入无法控制原生工具权限的 OpenCode 进程。',
      label_autoStart: '自动启动 OpenCode',
      hint_autoStart: '启动 DSH 时自动管理本地 OpenCode 服务；关闭后需要自己启动服务。',
      label_autoStartDirect: '移除子进程代理环境变量',
      hint_autoStartDirect: '仅影响 OpenCode 子进程的 HTTP(S)/ALL_PROXY，不修改系统 VPN 或代理设置。',
      label_endpoint: '服务地址',
      hint_endpoint: '默认 http://127.0.0.1:4096；托管模式要求本地回环 HTTP。',
      label_opencodeExecutable: 'OpenCode 可执行文件路径',
      hint_opencodeExecutable: '留空自动发现；Windows 默认为本地安装的 opencode.exe。',
      label_runtimeRoot: '运行目录',
      hint_runtimeRoot: '留空使用自动选择的独立运行目录。',
      label_username: 'Basic Auth 用户名',
      hint_username: '本地服务认证使用的用户名。',
      label_passwordEnv: '外部服务密码变量',
      hint_passwordEnv: '仅用于连接手动服务；托管子进程始终生成随机密码。',
      label_timeoutMs: '模型请求超时（毫秒）',
      hint_timeoutMs: '1 到 2147483647 的整数。',
      label_autoStartTimeoutMs: '服务启动超时（毫秒）',
      hint_autoStartTimeoutMs: '自动启动 OpenCode 等待健康检查的最大时长。',
      label_models: '模型 ID 列表',
      hint_models: '每行一个模型 ID；下拉列表中的模型不保证网关一定可用。',
    };
    const en = {
      title: 'OpenCode model bridge',
      description: 'Configure the local OpenCode server, models and DSH-owned tools.',
      restart: 'Fully restart DSH Desktop after saving. Server, model and security changes take effect on restart.',
      unavailable: 'The OpenCode plugin is not active, so its configuration is unavailable.',
      readOnly: 'This DSH profile is read-only.',
      saveFailed: 'Settings were not saved. Review the values and retry.',
      save: 'Save settings', saving: 'Saving…', reset: 'Reset to default', overridden: 'Overridden',
      invalid: 'Enter a valid value.', safety: 'Model and tools', service: 'Local server', advanced: 'Advanced configuration',
      listHint: 'One OpenCode model ID per line, or comma-separated.',
      label_guardedReadCompatibility: 'Guarded read compatibility',
      hint_guardedReadCompatibility: 'Experimental: advertises read to free models while a verified guard blocks every native OpenCode tool execution.',
      label_ssePreviewEnabled: 'SSE streaming preview',
      hint_ssePreviewEnabled: 'Off by default; streams text only when the OpenCode event feed works. Tool calls remain buffered.',
      label_toolBridgeEnabled: 'DSH tool bridge',
      hint_toolBridgeEnabled: 'Routes experimental model tool requests to DSH, where approvals and execution remain.',
      label_localTitles: 'Local session titles',
      hint_localTitles: 'Use a short excerpt from the user message instead of another model call.',
      label_strictOwnedServer: 'Require managed local server',
      hint_strictOwnedServer: 'Keep enabled to avoid servers whose native tool privileges cannot be verified.',
      label_autoStart: 'Auto-start OpenCode',
      hint_autoStart: 'Manage a local OpenCode process when DSH starts.',
      label_autoStartDirect: 'Remove child proxy variables',
      hint_autoStartDirect: 'Only removes HTTP(S)/ALL_PROXY from the child process; never changes system VPN or proxy.',
      label_endpoint: 'Server URL',
      hint_endpoint: 'Default http://127.0.0.1:4096; managed mode requires loopback HTTP.',
      label_opencodeExecutable: 'OpenCode executable',
      hint_opencodeExecutable: 'Leave empty to discover the installation.',
      label_runtimeRoot: 'Runtime directory',
      hint_runtimeRoot: 'Leave empty to use an isolated automatic location.',
      label_username: 'Basic Auth username',
      hint_username: 'User name for local server authentication.',
      label_passwordEnv: 'External password variable',
      hint_passwordEnv: 'Only for manually started services; managed services use random passwords.',
      label_timeoutMs: 'Request timeout (ms)',
      hint_timeoutMs: 'Integer between 1 and 2147483647.',
      label_autoStartTimeoutMs: 'Startup timeout (ms)',
      hint_autoStartTimeoutMs: 'Maximum time to wait for the local OpenCode process.',
      label_models: 'Model IDs',
      hint_models: 'One model ID per line; listed models are not guaranteed to be available.',
    };

    function booleanField(field) {
      return {
        field,
        format: value => String(typeof value === 'boolean' ? value : BOOLEAN_DEFAULT[field]),
        parse: text => text === 'true' || text === 'false'
          ? { kind: 'set', value: text === 'true' } : undefined,
      };
    }
    function integerField(field) {
      return {
        field,
        format: value => typeof value === 'number' ? String(value) : '',
        parse(text) {
          if (!text.trim()) return { kind: 'clear' };
          const n = Number(text);
          return Number.isSafeInteger(n) && n >= 1 && n <= 2147483647
            ? { kind: 'set', value: n } : undefined;
        },
      };
    }
    function modelListField() {
      return {
        field: LIST,
        format: value => Array.isArray(value) ? value.join('\n') : '',
        parse(text) {
          if (!text.trim()) return { kind: 'clear' };
          const items = text.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
          return items.length && items.length <= 64 && new Set(items).size === items.length
            ? { kind: 'set', value: items } : undefined;
        },
      };
    }

    const styles = {
      group: { display: 'grid', gap: '14px', margin: '0 0 24px', maxWidth: '720px' },
      heading: { fontSize: '14px', fontWeight: 600, margin: '0 0 2px' },
      check: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' },
      checkbox: { width: '16px', height: '16px', cursor: 'pointer' },
      hint: { margin: '5px 0 0 26px', opacity: 0.7, fontSize: '12px', lineHeight: 1.5 },
      reset: { marginLeft: '26px', background: 'none', border: 'none', textDecoration: 'underline',
        cursor: 'pointer', opacity: 0.75, fontSize: '12px', padding: 0 },
      input: { display: 'block', boxSizing: 'border-box', width: '100%', minHeight: '90px',
        borderRadius: '6px', padding: '10px', color: 'inherit', background: 'transparent',
        border: '1px solid currentColor', opacity: 0.85, font: 'inherit' },
      warning: { margin: '0 0 18px', fontSize: '12px', opacity: 0.8, lineHeight: 1.6 },
    };

    function Checkbox(props) {
      const { state, name, t, edit, resetField } = props;
      const field = state.fields[name];
      return h('div', { key: name }, [
        h('label', { key: 'label', style: styles.check }, [
          h('input', { key: 'input', type: 'checkbox', style: styles.checkbox,
            disabled: !state.writable || state.saving, checked: field.text === 'true',
            onChange: event => edit(name, String(event.target.checked)) }),
          h('span', { key: 'text' }, t('label_' + name)),
        ]),
        h('p', { key: 'hint', style: styles.hint }, t('hint_' + name)),
        field.overridden ? h('button', { key: 'reset', type: 'button', style: styles.reset,
          disabled: !state.writable || state.saving,
          onClick: () => resetField(name) }, t('reset')) : null,
      ]);
    }

    function FormPage(props) {
      const state = props.useOpencodeSettings(x => x);
      const t = props.t;
      if (props.view === 'summary') return t('description');
      const check = name => h(Checkbox, {
        key: name, name, t, state, edit: props.edit, resetField: props.resetField,
      });
      const input = name => h(SettingsValueField, {
        key: name, id: 'opencode-config-' + name, label: t('label_' + name),
        hint: t('hint_' + name), overriddenLabel: t('overridden'),
        resetLabel: t('reset'), invalidLabel: t('invalid'),
        numeric: NUMBER.includes(name),
        disabled: !state.writable || state.saving,
        ...state.fields[name],
        onEdit: text => props.edit(name, text),
        onReset: () => props.resetField(name),
      });
      const list = state.fields.models;
      return h(SettingsForm, {
        labels: { unavailable: t('unavailable'), readOnly: t('readOnly'),
          saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
        state, onSave: props.save, onDiscard: props.discard,
      }, [
        h('p', { key: 'restart', style: styles.warning, role: 'note' }, t('restart')),
        h('section', { key: 'safety', style: styles.group }, [
          h('h4', { key: 'title', style: styles.heading }, t('safety')),
          ...BOOLEAN.slice(0, 4).map(check),
        ]),
        h('section', { key: 'service', style: styles.group }, [
          h('h4', { key: 'title', style: styles.heading }, t('service')),
          ...BOOLEAN.slice(4).map(check),
        ]),
        h('details', { key: 'advanced', style: { ...styles.group, display: 'block' } }, [
          h('summary', { key: 'summary', style: { ...styles.heading, cursor: 'pointer' } }, t('advanced')),
          h('div', { key: 'content', style: { ...styles.group, marginTop: '16px' } }, [
            ...TEXT.map(input),
            ...NUMBER.map(input),
            h('div', { key: 'models' }, [
              h('label', { key: 'label', htmlFor: 'opencode-config-models' }, t('label_models')),
              h('textarea', { key: 'textarea', id: 'opencode-config-models',
                style: styles.input, value: list.text, disabled: !state.writable || state.saving,
                onChange: event => props.edit('models', event.target.value) }),
              h('p', { key: 'hint', style: { ...styles.hint, marginLeft: 0 } },
                list.invalid ? t('invalid') : t('hint_models')),
              list.overridden ? h('button', { key: 'reset', type: 'button',
                style: { ...styles.reset, marginLeft: 0 }, disabled: !state.writable || state.saving,
                onClick: () => props.resetField('models') }, t('reset')) : null,
            ]),
          ]),
        ]),
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-opencode: settings translations');
      const form = new SettingsFormModel(ctx.configForms.get(ENTRY), [
        ...BOOLEAN.map(booleanField), ...TEXT.map(settingsTextField),
        ...NUMBER.map(integerField), modelListField(),
      ]);
      const store = form.bind(() => ({
        ...form.shell(),
        fields: Object.fromEntries(FIELDS.map(field => [field, form.field(field)])),
      }));
      const face = { hooks: { opencodeSettings: store }, ...form.actions() };
      ctx.effect(() => () => form.dispose(), 'dsh-opencode: settings form lifecycle');
      ctx.effect(() => ctx.configForms.whileServed([ENTRY], () =>
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: BUNDLE, locale: NS,
          inject: () => face,
        }, FormPage))), 'dsh-opencode: plugin settings page');
    }

    return { inject: ['slots', 'locale', 'configForms'], apply };
  },
});

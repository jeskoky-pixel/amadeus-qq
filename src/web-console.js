// Minimal same-origin Web Console served by the existing QQ management route.
// It never embeds server data into HTML: the page fetches /scenes and renders
// with createElement/textContent. No inline script, style or event handlers.

export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Amadeus QQ Console</title>
  <link rel="stylesheet" href="console.css">
</head>
<body>
  <header>
    <h1>Amadeus QQ Console</h1>
    <button id="refresh" type="button">刷新</button>
  </header>
  <main>
    <section class="panel" id="status"></section>
    <section class="panel">
      <h2>授权 Scene</h2>
      <div id="scenes"></div>
    </section>
    <p id="message" class="message" role="status" aria-live="polite"></p>
  </main>
  <script src="console.js"></script>
</body>
</html>
`

export const CONSOLE_CSS = `:root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 18px; max-width: 1100px; margin-inline: auto; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h1 { font-size: 20px; margin: 0 0 14px; }
h2 { font-size: 16px; margin: 0 0 8px; }
.panel { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 12px; margin: 0 0 14px; }
.scene { border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 12px 0; }
.scene:first-child { border-top: 0; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 0; }
.row label { min-width: 180px; }
.muted { opacity: .72; }
.chip { border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.ok { color: #16794b; }
.warn { color: #9a5b00; }
.bad { color: #a51f1f; }
.message { min-height: 1.4em; white-space: pre-wrap; }
button, select { font: inherit; }
button { cursor: pointer; }
`

export const CONSOLE_JS = `'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const status = $('status');
  const scenes = $('scenes');
  const message = $('message');
  const refresh = $('refresh');

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function showError(error) {
    message.className = 'message bad';
    message.textContent = String(error);
  }

  function showInfo(text) {
    message.className = 'message';
    message.textContent = String(text);
  }

  function chip(text, cls) {
    return el('span', text, 'chip ' + (cls || ''));
  }

  function providerLabel(provider) {
    if (provider?.enabled === true) return '已启用';
    if (provider?.configured === true) return '已配置';
    if (provider?.installed === true) return '已安装';
    return '不可用';
  }

  function renderStatus(data) {
    status.replaceChildren();
    const health = data.health || {};
    const row = el('div', null, 'row');
    row.append(el('strong', '运行状态'));
    row.append(chip(health.enabled ? '已启用' : '已停用', health.enabled ? 'ok' : 'warn'));
    row.append(el('span', 'NapCat 连接：' + String(health.transport || 'unknown'), 'muted'));
    status.append(row);
    const providers = data.providers || {};
    const p = el('div', null, 'row');
    p.append(el('strong', '可选 Provider'));
    p.append(el('span', '媒体发送：' + providerLabel(providers.mediaSend), 'muted'));
    p.append(el('span', 'QZone：' + providerLabel(providers.qzone), 'muted'));
    status.append(p);
    const owner = data.ownerWorkspace || {};
    status.append(el('div', 'Owner 工作区：' + (owner.configured ? '已配置' : '未配置') +
      '；写入：' + (owner.writes ? '允许' : '关闭'), 'muted'));
  }

  function capabilityRow(cap, sceneState) {
    const row = el('div', null, 'row');
    const label = el('label', (cap.id === 'qq.qzone.use' ? '使用 QQ 空间' : cap.id));
    const select = document.createElement('select');
    select.disabled = cap.implemented !== true;
    for (const value of ['inherit', 'allow', 'deny']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.selected = (sceneState.overrides[cap.id] || cap.override || 'inherit') === value;
      select.append(option);
    }
    select.addEventListener('change', () => {
      if (select.value === 'inherit') delete sceneState.overrides[cap.id];
      else sceneState.overrides[cap.id] = select.value;
    });
    const state = el('span', cap.implemented
      ? (cap.effective ? '当前允许' : '当前拒绝')
      : '策略占位，尚不可执行', cap.implemented ? (cap.effective ? 'ok' : 'warn') : 'warn');
    row.append(label, select, state);
    if (cap.reason) row.append(el('span', '原因：' + String(cap.reason), 'muted'));
    return row;
  }

  function renderScene(scene, modes) {
    const state = {
      mode: scene.permissions?.mode || scene.effectiveMode || 'safe-chat',
      overrides: { ...(scene.permissions?.overrides || {}) },
      expectedRevision: scene.revision || 0,
    };
    const box = el('div', null, 'scene');
    const title = el('div', null, 'row');
    title.append(el('strong', scene.scene?.kind + ' ' + scene.scene?.peerId));
    title.append(el('span', 'revision ' + state.expectedRevision, 'muted'));
    title.append(el('span', '当前模式 ' + String(scene.effectiveMode || ''), 'muted'));
    box.append(title);

    const modeRow = el('div', null, 'row');
    modeRow.append(el('label', 'Scene 模式'));
    const mode = document.createElement('select');
    for (const id of modes) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      option.selected = id === state.mode;
      mode.append(option);
    }
    mode.addEventListener('change', () => { state.mode = mode.value; });
    modeRow.append(mode);
    box.append(modeRow);

    for (const cap of (scene.capabilities || [])) {
      if (cap.id === 'qq.qzone.read' || cap.id === 'qq.qzone.publish') continue;
      box.append(capabilityRow(cap, state));
    }

    const save = el('button', '保存此 Scene');
    save.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const response = await fetch('scenes/permissions', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-amadeus-qq': '1' },
          body: JSON.stringify({
            scene: { botId: scene.scene.botId, kind: scene.scene.kind, peerId: scene.scene.peerId },
            access: { mode: state.mode, overrides: state.overrides },
            expectedRevision: state.expectedRevision,
          }),
        });
        const body = await response.json();
        if (response.status === 409) {
          showError('保存冲突：Scene 已被其他窗口修改，已刷新最新状态。');
          await load();
          return;
        }
        if (!response.ok) {
          showError('保存失败：' + String(body.code || response.status));
          return;
        }
        showInfo('已保存。');
        await load();
      } catch (error) {
        showError('请求失败：' + String(error && error.message || error));
      } finally {
        save.disabled = false;
      }
    });
    box.append(save);
    return box;
  }

  async function load() {
    refresh.disabled = true;
    try {
      const response = await fetch('scenes', { credentials: 'same-origin' });
      const body = await response.json();
      if (!response.ok) {
        showError('读取失败：' + String(body.code || response.status));
        return;
      }
      const data = body.data || {};
      renderStatus(data);
      scenes.replaceChildren();
      const modes = Array.isArray(data.modes) ? data.modes : [];
      for (const scene of (data.scenes || [])) scenes.append(renderScene(scene, modes));
      if (!(data.scenes || []).length) scenes.append(el('p', '暂无授权 Scene。', 'muted'));
      showInfo('');
    } catch (error) {
      showError('读取失败：' + String(error && error.message || error));
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  load();
})();
`

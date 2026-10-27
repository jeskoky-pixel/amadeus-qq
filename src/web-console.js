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
    <section class="panel" aria-labelledby="graph-title">
      <div class="graph-head">
        <div><h2 id="graph-title">QQ 场景关系图</h2><p class="muted">根据已授权 Scene 和已观察到的 QQ ID 绘制；节点不代表已确认的记忆实体。</p></div>
        <div class="graph-controls"><label for="graph-filter">筛选</label><input id="graph-filter" type="search" placeholder="群号或 QQ 号"><button id="graph-reset" type="button">重置视图</button></div>
      </div>
      <div class="graph-wrap" id="graph-wrap" tabindex="0" role="region" aria-label="场景关系图，可横向滚动">
        <svg id="graph" viewBox="0 0 900 620" role="group" aria-label="QQ 场景关系图" aria-describedby="graph-detail graph-note"></svg>
      </div>
      <p class="muted graph-scroll-hint">中等宽度可横向滚动查看完整关系图；窄屏自动切换为列表视图。节点可用 Tab 聚焦，Enter/空格选择，方向键移动。</p>
      <div id="graph-list" class="graph-list" role="region" aria-label="场景列表视图"></div>
      <p id="graph-note" class="muted"></p>
      <p id="graph-detail" class="muted" role="status" aria-live="polite">选择节点查看连接关系。</p>
    </section>
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
button, select, input { font: inherit; }
button { cursor: pointer; }
.graph-head, .graph-controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.graph-head h2 { margin-bottom: 2px; }
.graph-head p { margin: 0 0 10px; }
.graph-controls input { min-width: 170px; padding: 5px 8px; }
.graph-wrap { max-width: 900px; overflow-x: auto; overflow-y: hidden; border-radius: 8px; }
.graph-wrap:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
#graph { display: block; width: 900px; height: 620px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; background: color-mix(in srgb, currentColor 3%, transparent); }
.graph-scroll-hint { display: none; }
.graph-list { display: none; }
.graph-list-card { border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 10px 0; }
.graph-list-card:first-child { border-top: 0; }
.graph-list-card h3 { font-size: 14px; margin: 0 0 4px; }
.graph-list-card p { margin: 4px 0; }
@media (max-width: 900px) {
  .graph-scroll-hint { display: block; }
}
@media (max-width: 700px) {
  .graph-wrap { display: none; }
  .graph-scroll-hint { display: none; }
  .graph-list { display: block; }
}
#graph-note:empty { display: none; }
.graph-edge { stroke: currentColor; stroke-opacity: .22; stroke-width: 1.5; }
.graph-node { cursor: pointer; }
.graph-node circle { stroke: currentColor; stroke-opacity: .32; stroke-width: 1.5; }
.graph-node text { fill: currentColor; font: 12px system-ui, sans-serif; text-anchor: middle; pointer-events: none; }
.graph-node title { pointer-events: none; }
.graph-node.bot circle { fill: #668cff; }
.graph-node.group circle { fill: #7bcba4; }
.graph-node.private circle { fill: #d8a6eb; }
.graph-node.person circle { fill: #f2ca7e; }
.graph-node:focus circle, .graph-node:hover circle { stroke-width: 3; stroke-opacity: 1; }
`

export const CONSOLE_JS = `'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const status = $('status');
  const scenes = $('scenes');
  const message = $('message');
  const refresh = $('refresh');
  const graph = $('graph');
  const graphFilter = $('graph-filter');
  const graphDetail = $('graph-detail');
  const graphNote = $('graph-note');
  const graphList = $('graph-list');
  let graphScenes = [];
  const MAX_SCENES = 24;
  const MAX_PEOPLE = 30;
  const MAX_PARTICIPANTS = 20;
  const MAX_LIST_PARTICIPANTS = 8;
  const MAX_LABEL = 22;

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

  function safeText(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function shortText(value, max) {
    const text = safeText(value);
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function matchesScene(item, needle) {
    if (!needle) return true;
    const peer = item.scene || {};
    const fields = [item.key, peer.botId, peer.kind, peer.peerId, item.effectiveMode];
    const participants = Array.isArray(item.activity?.participantIds) ? item.activity.participantIds : [];
    return fields.concat(participants).some(value => safeText(value).toLowerCase().includes(needle));
  }

  function renderGraphList(items) {
    graphList.replaceChildren();
    if (!items.length) {
      graphList.append(el('p', '没有匹配的已授权 Scene。', 'muted'));
      return;
    }
    for (const item of items) {
      const peer = item.scene || {};
      const card = el('article', null, 'graph-list-card');
      card.append(el('h3', (peer.kind === 'group' ? '群 ' : '私聊 ') + safeText(peer.peerId)));
      card.append(el('p', 'Bot ' + safeText(peer.botId) + ' · 模式 ' +
        safeText(item.effectiveMode) + ' · 保留观察 ' +
        (Number(item.activity?.observedCount) || 0) + ' 条', 'muted'));
      const ids = Array.isArray(item.activity?.participantIds) ? item.activity.participantIds : [];
      const participantRow = el('p', '已观察 QQ ID：');
      if (!ids.length) {
        participantRow.append(el('span', '暂无', 'muted'));
      } else {
        for (const raw of ids.slice(0, MAX_LIST_PARTICIPANTS)) {
          const id = safeText(raw);
          if (!id || id.length > 40) continue;
          participantRow.append(chip('QQ ' + shortText(id, 16)));
        }
        if (ids.length > MAX_LIST_PARTICIPANTS) {
          participantRow.append(el('span', '+ ' + (ids.length - MAX_LIST_PARTICIPANTS) + ' 个', 'muted'));
        }
      }
      card.append(participantRow);
      graphList.append(card);
    }
  }

  function svgEl(tag, attributes) {
    const node = document.createElementNS('http:' + '//www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function renderGraph() {
    graph.replaceChildren();
    graphList.replaceChildren();
    graphNote.textContent = '';
    const query = graphFilter.value.trim().toLowerCase();
    if (!graphScenes.length) {
      graphDetail.textContent = '暂无可绘制的 Scene。';
      renderGraphList([]);
      return;
    }
    const matched = graphScenes.filter(item => matchesScene(item, query));
    const visible = matched.slice(0, MAX_SCENES);
    if (!visible.length) {
      graphDetail.textContent = '没有匹配的已授权 Scene。';
      graphNote.textContent = '可按群号、QQ 号、Bot 号或模式筛选。';
      renderGraphList([]);
      return;
    }
    const nodes = new Map();
    const edges = [];
    const add = (id, kind, label, ariaLabel) => {
      if (!nodes.has(id)) nodes.set(id, { id, kind, label, ariaLabel, scenes: new Set() });
      return nodes.get(id);
    };
    const participantTotal = new Set();
    for (const item of visible) {
      const peer = item.scene || {};
      const sceneId = safeText(item.key) || (
        safeText(peer.botId) + ':' + safeText(peer.kind) + ':' + safeText(peer.peerId));
      const botLabel = 'Bot ' + safeText(peer.botId);
      const bot = add('bot:' + safeText(peer.botId), 'bot', shortText(botLabel, MAX_LABEL), botLabel);
      const sceneKind = peer.kind === 'group' ? '群' : '私聊';
      const sceneLabel = sceneKind + ' ' + safeText(peer.peerId);
      const scene = add('scene:' + sceneId, peer.kind === 'group' ? 'group' : 'private',
        shortText(sceneLabel, MAX_LABEL), sceneLabel);
      scene.mode = safeText(item.effectiveMode);
      scene.observedCount = Number(item.activity?.observedCount) || 0;
      scene.ariaLabel = sceneLabel + ' · 模式 ' + scene.mode +
        ' · 保留观察 ' + scene.observedCount + ' 条';
      edges.push([bot.id, scene.id]);
      const ids = Array.isArray(item.activity?.participantIds) ? item.activity.participantIds : [];
      for (const raw of ids.slice(0, MAX_PARTICIPANTS)) {
        const id = safeText(raw);
        if (!id || id.length > 40) continue;
        participantTotal.add(id);
        const personLabel = 'QQ ' + id;
        const person = add('person:' + id, 'person', shortText(personLabel, MAX_LABEL), personLabel);
        person.scenes.add(sceneLabel);
        edges.push([scene.id, person.id]);
      }
    }
    const all = [...nodes.values()];
    const bots = all.filter(node => node.kind === 'bot');
    const rooms = all.filter(node => node.kind === 'group' || node.kind === 'private');
    const people = all.filter(node => node.kind === 'person').slice(0, MAX_PEOPLE);
    const layoutEllipse = (items, radiusX, radiusY) => items.forEach((node, index) => {
      const angle = -Math.PI / 2 + 2 * Math.PI * index / Math.max(items.length, 1);
      node.x = 450 + radiusX * Math.cos(angle);
      node.y = 310 + radiusY * Math.sin(angle);
    });
    layoutEllipse(bots, bots.length > 1 ? 85 : 0, bots.length > 1 ? 60 : 0);
    layoutEllipse(rooms, rooms.length > 12 ? 300 : rooms.length > 6 ? 250 : 205,
      rooms.length > 12 ? 205 : rooms.length > 6 ? 175 : 145);
    const innerPeople = people.slice(0, 15);
    const outerPeople = people.slice(15);
    layoutEllipse(innerPeople, 350, 250);
    layoutEllipse(outerPeople, 385, 270);
    const shown = new Map([...bots, ...rooms, ...people].map(node => [node.id, node]));
    for (const [from, to] of edges) {
      const a = shown.get(from), b = shown.get(to);
      if (a && b) graph.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'graph-edge' }));
    }
    const ordered = [...shown.values()];
    const elements = new Map();
    const selectNode = node => {
      graphDetail.textContent = node.kind === 'person'
        ? node.ariaLabel + ' · 已在 ' + [...node.scenes].join('、') + ' 观察到'
        : node.kind === 'bot' ? node.ariaLabel + ' · 已授权 Scene ' + rooms.length + ' 个'
          : node.ariaLabel;
    };
    for (const node of ordered) {
      const group = svgEl('g', { class: 'graph-node ' + node.kind, tabindex: '0', role: 'button',
        'aria-label': node.ariaLabel });
      const title = svgEl('title', {});
      title.textContent = node.ariaLabel;
      group.append(title);
      group.append(svgEl('circle', { cx: node.x, cy: node.y, r: node.kind === 'bot' ? 28 : 18 }));
      const label = svgEl('text', { x: node.x, y: node.y + 35 });
      label.textContent = node.label;
      group.append(label);
      const index = ordered.indexOf(node);
      group.addEventListener('click', () => selectNode(node));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectNode(node);
          return;
        }
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (event.key === 'Home' || event.key === 'End' || step) {
          event.preventDefault();
          const next = event.key === 'Home' ? ordered[0]
            : event.key === 'End' ? ordered[ordered.length - 1]
              : ordered[(index + step + ordered.length) % ordered.length];
          elements.get(next.id)?.focus?.();
        }
      });
      elements.set(node.id, group);
      graph.append(group);
    }
    const notes = [];
    if (matched.length > visible.length) {
      notes.push('匹配 ' + matched.length + ' 个 Scene，仅显示前 ' + visible.length + ' 个');
    }
    if (participantTotal.size > MAX_PEOPLE) {
      notes.push('已观察 QQ ID 共 ' + participantTotal.size + ' 个，图中最多显示 ' + MAX_PEOPLE + ' 个');
    }
    if (notes.length) graphNote.textContent = notes.join('；') + '。';
    graphDetail.textContent = '显示 ' + rooms.length + ' 个 Scene、' + people.length +
      ' 个已观察 QQ ID；选择节点查看连接关系。';
    renderGraphList(visible);
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
      graphScenes = Array.isArray(data.scenes) ? data.scenes : [];
      renderGraph();
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
  graphFilter.addEventListener('input', renderGraph);
  $('graph-reset').addEventListener('click', () => { graphFilter.value = ''; renderGraph(); });
  load();
})();
`

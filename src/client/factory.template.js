__CLIENT_LOGIC__

const PANEL_CSS = `
[data-amadeus-qq]{box-sizing:border-box;color:var(--dsw-alias-label-primary,#203333);font:13px/1.6 system-ui,sans-serif;max-width:760px}
[data-amadeus-qq] *{box-sizing:border-box}
[data-amadeus-qq] h2{font-size:21px;margin:0 0 5px}
[data-amadeus-qq] p{margin:0 0 14px;opacity:.75}
[data-amadeus-qq] .summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:14px 0}
[data-amadeus-qq] .metric{border:1px solid var(--dsw-alias-border-secondary,#8c8c8c55);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-2,#8c8c8c10)}
[data-amadeus-qq] .metric small{display:block;opacity:.68;font-size:11px}
[data-amadeus-qq] .metric strong{display:block;font-size:14px;margin-top:3px;word-break:break-word}
[data-amadeus-qq] button{border:1px solid #178a69;background:#178a69;color:white;border-radius:9px;padding:8px 14px;font:inherit;cursor:pointer}
[data-amadeus-qq] button:focus-visible{outline:2px solid #178a69;outline-offset:2px}
[data-amadeus-qq] .error{color:#ab3535;margin:12px 0}
@media(max-width:560px){[data-amadeus-qq] .summary{grid-template-columns:1fr}}
`

function Panel() {
  const [setup, setSetup] = React.useState(null)
  const [runtime, setRuntime] = React.useState(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [a, b] = await Promise.all([
          fetch('/api/amadeus-qq/setup', { credentials: 'same-origin' }),
          fetch('/api/amadeus-qq/scenes', { credentials: 'same-origin' }),
        ])
        const [left, right] = await Promise.all([a.json(), b.json()])
        if (!a.ok || !b.ok || !left.ok || !right.ok) throw new Error('请在 DSH Owner 会话中打开管理控制台')
        if (active) { setSetup(left.data); setRuntime(right.data); setError('') }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : '状态读取失败')
      }
    }
    void load()
    return () => { active = false }
  }, [])
  const workspace = setup?.workspaces?.find(item => item.id === setup.workspaceId)
  const rows = (setup?.groups?.length ?? 0) + (setup?.privatePeers?.length ?? 0)
  const transportText = { connected: '已连接', connecting: '连接中', disconnected: '未连接', disabled: '已暂停' }[runtime?.health?.transport] ?? '未连接'
  const metric = (label, value) => React.createElement('div', { className: 'metric' },
    React.createElement('small', null, label), React.createElement('strong', null, value))
  return React.createElement('div', { 'data-amadeus-qq': 'true' },
    React.createElement('style', null, PANEL_CSS),
    React.createElement('h2', null, 'Amadeus QQ'),
    React.createElement('p', null, '首次设置和详细权限在受 DSH Owner 保护的本地 Web Console 中完成。'),
    error ? React.createElement('div', { className: 'error', role: 'status' }, error) : null,
    React.createElement('div', { className: 'summary' },
      metric('插件', setup?.enabled ? '已启用' : '待配置'),
      metric('NapCat', transportText),
      metric('Bot / Owner', `${setup?.botId || '—'} / ${setup?.ownerId || '—'}`),
      metric('Workspace / 会话', `${workspace?.title || '未选择'} · ${rows} 个`)),
    React.createElement('button', { type: 'button', onClick: () => window.open('/api/amadeus-qq/console', '_blank', 'noopener,noreferrer') },
      setup?.enabled ? '打开 Web Console' : '开始首次设置'))
}

return {
  inject: ['slots'],
  apply(ctx) {
    let active
    const activate = () => {
      if (active) return active.dispose
      let dispose = () => {}
      try {
        dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'amadeus-qq', order: 30, label: () => 'Amadeus QQ',
        }, Panel)) || (() => {})
      } catch (error) { console.error('[amadeus-qq] settings.section unavailable', error) }
      const disposal = () => {
        if (!active || active.dispose !== disposal) return
        active = undefined
        try { dispose() } catch {}
      }
      active = { dispose: disposal }
      return disposal
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => activate(), 'amadeus-qq: settings page')
    else activate()
  },
}

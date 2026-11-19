/**
 * dsh-agent-memory-hub — DSH Web UI surface (client half).
 *
 * Registers a sidebar entry (`sidebar.panellist`) and its central panel
 * (`main`, keyed by the panel id). The panel embeds the `memhub serve`
 * console (inbox + knowledge browser + audit) via iframe on 127.0.0.1:7777
 * — the same local, human-only channel the standalone console uses, so all
 * data and actions keep flowing through one audited API.
 *
 * When `memhub serve` is not running, the panel shows recovery guidance and
 * keeps polling, so it lights up on its own the moment you start the server.
 * No network beyond 127.0.0.1 is touched.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-memory-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'agent-memory-hub-panel'
    const SERVE_BASE = 'http://127.0.0.1:7777'

    function PanelIcon() {
      // Memory-hub mark: a stacked database/disc glyph — reads at 20px.
      return h('svg', {
        viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('ellipse', { cx: 12, cy: 5.5, rx: 7, ry: 2.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M5 5.5v6.5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V5.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M5 12v6.5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 17.2, cy: 17.2, r: 3.4, fill: 'currentColor', opacity: 0.9 }),
        h('path', { d: 'M15.6 17.2l1.2 1.2 2-2.2', fill: 'none', stroke: '#fff', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function Panel() {
      // 'probing' only ever shows on first mount: probe() itself never
      // rewinds the status, so a healthy server keeps the iframe mounted
      // (the old version setStatus('probing') on every probe AND rebuilt
      // the interval from the [status] dependency — the iframe remounted
      // forever, which is the "panel never opens / keeps flashing" bug).
      const [status, setStatus] = React.useState('probing')
      const tickRef = React.useRef(() => {})

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          fetch(`${SERVE_BASE}/api/inbox`, { cache: 'no-store', signal: AbortSignal.timeout(2500) })
            .then((r) => { if (alive) setStatus(r.ok ? 'online' : 'offline') })
            .catch(() => { if (alive) setStatus('offline') })
        }
        tickRef.current = tick
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      if (status === 'online') {
        return h('iframe', {
          src: `${SERVE_BASE}/`,
          title: 'Agent Memory Hub 审核面板',
          style: { width: '100%', height: '100%', minHeight: 480, border: 'none', flex: 1 },
        })
      }

      return h('div', { style: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: 32, height: '100%', minHeight: 480, flex: 1,
        color: 'inherit', font: 'inherit', textAlign: 'center',
      } },
        h('div', { style: { fontSize: 34 } }, PanelIcon()),
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, status === 'probing' ? '正在连接记忆中枢…' : '本地控制台尚未就绪'),
        h('div', { style: { fontSize: 13, opacity: 0.75, lineHeight: 1.7, maxWidth: 460 } },
          'DSH 宿主会自动启动本地控制台（127.0.0.1:7777），重启 DSH 或稍等片刻即可；也可以在任意终端手动运行下面的命令立即启动。每 5 秒自动重试：'),
        h('code', { style: {
          padding: '8px 14px', borderRadius: 8, fontSize: 13,
          background: 'rgba(127,127,127,0.14)', userSelect: 'all',
        } }, 'memhub serve --root <你的hub目录>'),
        h('button', {
          onClick: () => { setStatus('probing'); tickRef.current() },
          disabled: status === 'probing',
          style: {
            marginTop: 6, padding: '7px 18px', borderRadius: 8, border: 'none',
            cursor: status === 'probing' ? 'default' : 'pointer', font: 'inherit', fontSize: 13,
            background: status === 'probing' ? 'rgba(127,127,127,0.2)' : 'rgba(36,123,191,0.9)', color: '#fff',
          },
        }, status === 'probing' ? '连接中…' : '立即重试'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 50,
          label: '记忆中枢',
        }, PanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({}),
        }, Panel))
      },
    }
  },
})

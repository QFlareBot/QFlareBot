/**
 * 插件页面示例：一个不用任何框架的 HTML。
 * 面板提供 /tokens.css（同色同字）与 /bridge.js（握手、鉴权 fetch、主题），页面只管自己的内容。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>按键点击记录</title>
<link rel="stylesheet" href="/tokens.css" />
<style>
  .row { display: flex; align-items: center; justify-content: space-between; gap: var(--qb-space-3); padding: var(--qb-space-2) 0; border-bottom: 1px solid var(--qb-border); font-size: var(--qb-text-sm); }
  .row:last-child { border-bottom: 0; }
  h1 { font-size: var(--qb-text-lg); margin: 0 0 var(--qb-space-1); }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--qb-space-3); }
</style>
</head>
<body class="qb-page" style="padding: var(--qb-space-4)">
  <div class="toolbar">
    <div><h1>按键点击记录</h1><p class="qb-muted" style="margin:0">回调按键每次被点击都会记到插件自己的 KV 里</p></div>
    <button id="clear" class="qb-btn">清空</button>
  </div>
  <div id="list" class="qb-card"><p class="qb-muted">加载中…</p></div>
  <script type="module">
    import { createBridge } from '/bridge.js'
    const list = document.getElementById('list')
    let bridge
    async function load() {
      const res = await bridge.fetch('/api/clicks')
      if (!res.ok) { list.innerHTML = '<p class="qb-muted">读取失败：' + res.status + '</p>'; return }
      const { clicks } = await res.json()
      list.innerHTML = clicks.length
        ? clicks.map((c) => '<div class="row"><span><b>' + c.buttonId + '</b> <span class="qb-muted">' + (c.buttonData || '') + '</span></span><span class="qb-mono qb-muted">' + c.userId + ' · ' + new Date(c.at).toLocaleTimeString('zh-CN', { hour12: false }) + '</span></div>').join('')
        : '<p class="qb-muted">还没有人点过按键。在群里发 /panel 试试。</p>'
      bridge.resize()
    }
    createBridge().then(async (b) => {
      bridge = b
      bridge.setTitle('按键点击记录')
      document.getElementById('clear').addEventListener('click', async () => {
        await bridge.fetch('/api/clicks', { method: 'DELETE' })
        bridge.toast('已清空点击记录', 'success')
        load()
      })
      load()
    })
  </script>
</body>
</html>`

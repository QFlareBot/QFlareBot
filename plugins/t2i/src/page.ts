/**
 * T2I 渲染服务插件页面：服务状态、连通性测试与试渲染。
 * 面板提供 /tokens.css（同色同字）与 /bridge.js（握手、鉴权 fetch、主题），页面只管自己的内容。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>T2I 渲染服务</title>
<link rel="stylesheet" href="/tokens.css" />
<style>
  h1 { font-size: var(--qb-text-lg); margin: 0 0 var(--qb-space-1); }
  .grid { display: grid; gap: var(--qb-space-3); }
  .card-title { font-size: var(--qb-text-sm); font-weight: 600; margin: 0 0 var(--qb-space-2); }
  .kv { display: flex; justify-content: space-between; gap: var(--qb-space-3); padding: var(--qb-space-1) 0; font-size: var(--qb-text-sm); }
  .kv .k { color: var(--qb-muted); flex-shrink: 0; }
  .kv .v { text-align: right; word-break: break-all; }
  .mono { font-family: var(--qb-font-mono); font-size: var(--qb-text-xs); }
  .actions { display: flex; gap: var(--qb-space-2); margin-top: var(--qb-space-3); align-items: center; flex-wrap: wrap; }
  .status { font-size: var(--qb-text-sm); }
  .status.ok { color: var(--qb-success, #16a34a); }
  .status.bad { color: var(--qb-danger, #dc2626); }
  textarea { width: 100%; min-height: 96px; resize: vertical; font-family: var(--qb-font-mono); font-size: var(--qb-text-xs); }
  #preview img { max-width: 100%; border-radius: var(--qb-radius, 8px); border: 1px solid var(--qb-border); }
  .meta { font-size: var(--qb-text-xs); color: var(--qb-muted); margin-top: var(--qb-space-2); }
</style>
</head>
<body class="qb-page" style="padding: var(--qb-space-4)">
  <div class="grid">
    <div class="qb-card" style="padding: var(--qb-space-3)">
      <p class="card-title">服务状态</p>
      <div class="kv"><span class="k">端点</span><span class="v mono" id="endpoint">…</span></div>
      <div class="kv"><span class="k">超时</span><span class="v" id="timeout">…</span></div>
      <div class="actions">
        <button id="test" class="qb-btn">测试连通性</button>
        <span class="status" id="status">未测试</span>
      </div>
      <p class="qb-muted" style="font-size: var(--qb-text-xs); margin: var(--qb-space-2) 0 0">
        服务地址在「插件 → T2I 渲染 → 配置」里填写（t2i_url）。其他插件声明 depends: { t2i: '*' } 后用 ctx.service('t2i') 复用同一节点。
      </p>
    </div>

    <div class="qb-card" style="padding: var(--qb-space-3)">
      <p class="card-title">试渲染</p>
      <textarea id="html" spellcheck="false">&lt;div style="font-family:sans-serif;padding:24px;background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;border-radius:16px"&gt;
  &lt;h1 style="margin:0 0 8px"&gt;Hello T2I&lt;/h1&gt;
  &lt;p style="margin:0;opacity:.9"&gt;HTML → 图片，就这么简单&lt;/p&gt;
&lt;/div&gt;</textarea>
      <div class="actions">
        <button id="render" class="qb-btn">渲染</button>
        <span class="meta" id="renderMeta"></span>
      </div>
      <div id="preview" style="margin-top: var(--qb-space-3)"></div>
    </div>
  </div>

  <script type="module">
    import { createBridge } from '/bridge.js'
    const $ = (id) => document.getElementById(id)
    let bridge

    async function loadConfig() {
      const res = await bridge.fetch('/api/config')
      if (!res.ok) { $('endpoint').textContent = '读取失败 ' + res.status; return }
      const cfg = await res.json()
      $('endpoint').textContent = cfg.endpoint
      $('timeout').textContent = (cfg.timeoutMs / 1000) + ' 秒'
    }

    async function test() {
      $('status').className = 'status'
      $('status').textContent = '渲染测试图…（冷启动可能较慢）'
      const res = await bridge.fetch('/api/test', { method: 'POST' })
      const r = await res.json()
      if (r.ok) {
        $('status').className = 'status ok'
        $('status').textContent = '正常 · ' + r.latencyMs + ' ms'
      } else {
        $('status').className = 'status bad'
        $('status').textContent = '失败：' + (r.error || '未知错误')
      }
    }

    async function render() {
      $('render').disabled = true
      $('renderMeta').textContent = '渲染中…（冷启动可能较慢）'
      const res = await bridge.fetch('/api/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html: $('html').value }),
      })
      const r = await res.json()
      $('render').disabled = false
      if (!r.ok) { $('renderMeta').textContent = '失败：' + (r.error || '未知错误'); return }
      $('renderMeta').textContent = r.latencyMs + ' ms · ' + (r.byteSize / 1024).toFixed(1) + ' KB'
      $('preview').innerHTML = '<img alt="渲染结果" src="data:image/jpeg;base64,' + r.base64 + '" />'
      bridge.resize()
    }

    createBridge().then(async (b) => {
      bridge = b
      bridge.setTitle('T2I 渲染服务')
      $('test').addEventListener('click', test)
      $('render').addEventListener('click', render)
      await loadConfig()
      bridge.resize()
    })
  </script>
</body>
</html>`

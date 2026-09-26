<script setup lang="ts">
// 插件市场：在浏览器里读插件目录的 index.json（QFlareBot/plugins 仓库生成、GitHub Pages 发布）。
// 放在客户端读，目录更新不用重新构建文档站。
//
// 安装要登录机器人面板，文档站做不了：点「安装」跳到你自己面板的插件市场页（/#/market?install=a,b），
// 在那里逐个预检、确认，勾几个都只构建一次。机器人地址只存在这个浏览器里。
import { computed, onMounted, ref } from 'vue'

const INDEX_URL = 'https://qflarebot.github.io/plugins/index.json'
const BOT_KEY = 'qflarebot.market.bot'

interface Plugin {
  name: string
  repo: string
  author?: string
  displayName?: string
  description?: string
  version?: string
  tags?: string[]
  permissions?: string[]
  commands?: Array<{ name: string; description?: string }>
  license?: string | null
  stars?: number
  updatedAt?: string | null
  status?: 'ok' | 'error'
  error?: string
}

const plugins = ref<Plugin[]>([])
const state = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const query = ref('')
const activeTag = ref<string | null>(null)
const sort = ref<'updated' | 'stars'>('updated')
const selected = ref(new Set<string>())
const botInput = ref('')
const botHint = ref('')
const botField = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  try {
    botInput.value = localStorage.getItem(BOT_KEY) ?? ''
  } catch {
    // 隐私模式等拿不到 localStorage：每次手填
  }
  try {
    const res = await fetch(INDEX_URL, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { plugins?: Plugin[] }
    plugins.value = data.plugins ?? []
    state.value = 'ready'
  } catch (err) {
    loadError.value = (err as Error).message
    state.value = 'error'
  }
})

/** 用户填的机器人地址 → origin；面板挂在根路径、用 hash 路由 */
function botOrigin(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    return new URL(s).origin
  } catch {
    return null
  }
}

const bot = computed(() => botOrigin(botInput.value))

function saveBot() {
  botHint.value = ''
  try {
    if (bot.value) localStorage.setItem(BOT_KEY, bot.value)
  } catch {
    // 存不了就算了，本页还能用
  }
}

function install(names: string[]) {
  if (!names.length) return
  if (!bot.value) {
    botHint.value = botInput.value.trim() ? '地址格式不对，填域名即可，例如 bot.example.com' : '先填你的机器人地址'
    botField.value?.focus()
    return
  }
  saveBot()
  window.open(`${bot.value}/#/market?install=${names.map(encodeURIComponent).join(',')}`, '_blank', 'noopener')
}

function toggle(name: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(name)
  else next.delete(name)
  selected.value = next
}

const tags = computed(() => {
  const counts = new Map<string, number>()
  for (const p of plugins.value) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([t]) => t)
})

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = plugins.value.filter((p) => {
    if (activeTag.value && !(p.tags ?? []).includes(activeTag.value)) return false
    if (!q) return true
    const haystack = [p.name, p.displayName, p.description, p.author, ...(p.tags ?? []), ...(p.commands ?? []).map((c) => c.name)]
    return haystack.some((s) => s?.toLowerCase().includes(q))
  })
  return list.sort((a, b) =>
    sort.value === 'stars'
      ? (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name)
      : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name),
  )
})

function formatDate(iso?: string | null) {
  return iso ? new Date(iso).toLocaleDateString('zh-CN') : ''
}
</script>

<template>
  <div class="market">
    <div class="bot">
      <label for="market-bot" class="bot-label">你的机器人地址</label>
      <input
        id="market-bot"
        ref="botField"
        v-model="botInput"
        class="field"
        type="url"
        inputmode="url"
        placeholder="bot.example.com"
        autocomplete="url"
        @change="saveBot"
      />
      <p class="bot-hint" :class="{ warn: botHint }" aria-live="polite">
        {{ botHint || '点「安装」会打开你的面板，在那里预检、确认；勾几个都只构建一次。地址只存在这个浏览器里。' }}
      </p>
    </div>

    <div class="toolbar">
      <input v-model="query" class="field search" type="search" placeholder="搜索名称、描述、作者、命令" aria-label="搜索插件" />
      <select v-model="sort" class="field sort" aria-label="排序">
        <option value="updated">最近更新</option>
        <option value="stars">星数</option>
      </select>
    </div>

    <div v-if="tags.length" class="tags" role="group" aria-label="按标签筛选">
      <button type="button" class="tag" :class="{ active: activeTag === null }" @click="activeTag = null">全部</button>
      <button
        v-for="t in tags"
        :key="t"
        type="button"
        class="tag"
        :class="{ active: activeTag === t }"
        @click="activeTag = activeTag === t ? null : t"
      >
        {{ t }}
      </button>
    </div>

    <p v-if="state === 'loading'" class="hint">正在读取插件目录…</p>
    <p v-else-if="state === 'error'" class="hint">
      读取插件目录失败（{{ loadError }}）。可以直接打开 <a :href="INDEX_URL" target="_blank" rel="noopener">index.json</a> 看看。
    </p>
    <p v-else-if="shown.length === 0" class="hint">没有符合条件的插件。</p>

    <div v-else class="grid">
      <article v-for="p in shown" :key="p.name" class="card" :class="{ picked: selected.has(p.name) }">
        <header class="head">
          <label class="pick">
            <input type="checkbox" :checked="selected.has(p.name)" @change="toggle(p.name, ($event.target as HTMLInputElement).checked)" />
            <span class="title">{{ p.displayName || p.name }}</span>
          </label>
          <span v-if="p.version" class="version">v{{ p.version }}</span>
        </header>
        <p class="ident">
          <code>{{ p.name }}</code>
          <span v-if="p.author"> · {{ p.author }}</span>
          <span v-if="p.stars !== undefined"> · ★ {{ p.stars }}</span>
          <span v-if="p.license"> · {{ p.license }}</span>
          <span v-if="p.updatedAt"> · {{ formatDate(p.updatedAt) }} 更新</span>
        </p>
        <p v-if="p.description" class="desc">{{ p.description }}</p>
        <p v-if="p.commands?.length" class="commands">
          <code v-for="c in p.commands.slice(0, 6)" :key="c.name" :title="c.description">/{{ c.name }}</code>
          <span v-if="p.commands.length > 6" class="more">等 {{ p.commands.length }} 个命令</span>
        </p>
        <p v-if="p.permissions?.length" class="perms">权限：{{ p.permissions.join('、') }}</p>
        <p v-if="p.status === 'error'" class="problem">最近一次读取失败：{{ p.error }}</p>
        <div v-if="p.tags?.length" class="card-tags">
          <span v-for="t in p.tags" :key="t" class="chip">{{ t }}</span>
        </div>
        <footer class="actions">
          <button type="button" class="primary" @click="install([p.name])">安装</button>
          <a class="secondary" :href="`https://github.com/${p.repo}`" target="_blank" rel="noopener">仓库</a>
        </footer>
      </article>
    </div>

    <div v-if="selected.size" class="batch" role="region" aria-label="批量安装">
      <span>已选 {{ selected.size }} 个</span>
      <button type="button" class="link" @click="selected = new Set()">清空</button>
      <button type="button" class="primary" @click="install([...selected])">在我的机器人上安装（构建一次）</button>
    </div>
  </div>
</template>

<style scoped>
.market {
  margin-top: 24px;
}
.bot {
  display: grid;
  gap: 6px;
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}
.bot-label {
  font-size: 14px;
  font-weight: 500;
}
.bot-hint {
  margin: 0;
  color: var(--vp-c-text-3);
  font-size: 12px;
  line-height: 1.6;
}
.bot-hint.warn {
  color: var(--vp-c-warning-1);
}
.toolbar {
  display: flex;
  gap: 8px;
}
.field {
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 14px;
}
.search {
  flex: 1;
  min-width: 0;
}
.field:focus {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -1px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.tag {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  cursor: pointer;
}
.tag:hover {
  color: var(--vp-c-text-1);
}
.tag.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.hint {
  color: var(--vp-c-text-2);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 20px;
}
.card {
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.card.picked {
  border-color: var(--vp-c-brand-1);
}
.card p {
  margin: 0;
  line-height: 1.6;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.pick input {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  accent-color: var(--vp-c-brand-1);
  cursor: pointer;
}
.title {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.4;
}
.version {
  flex-shrink: 0;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}
.ident {
  margin-top: 2px !important;
  color: var(--vp-c-text-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.desc {
  margin-top: 10px !important;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.commands {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 10px !important;
  font-size: 12px;
}
.more,
.perms {
  color: var(--vp-c-text-3);
  font-size: 12px;
}
.perms {
  margin-top: 6px !important;
}
.problem {
  margin-top: 10px !important;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--vp-c-warning-soft);
  color: var(--vp-c-warning-1);
  font-size: 12px;
}
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 10px;
}
.chip {
  padding: 0 8px;
  border-radius: 4px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 22px;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 14px;
}
.primary,
.secondary {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
}
.primary {
  background: var(--vp-c-brand-3);
  color: var(--vp-c-white);
}
.primary:hover {
  background: var(--vp-c-brand-2);
}
.secondary {
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-1);
}
.secondary:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.batch {
  position: sticky;
  bottom: 16px;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  padding: 10px 12px 10px 16px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 12px;
  background: var(--vp-c-bg);
  box-shadow: var(--vp-shadow-3);
  font-size: 14px;
}
.batch .primary {
  margin-left: auto;
}
.link {
  color: var(--vp-c-text-2);
  font-size: 13px;
  cursor: pointer;
}
.link:hover {
  color: var(--vp-c-brand-1);
}
</style>

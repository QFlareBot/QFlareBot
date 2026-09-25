<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderSVG } from 'uqr'
import { api } from '../api/client.js'
import type { SavedBot } from '../api/types.js'
import PageHeader from '../components/PageHeader.vue'
import QButton from '../components/ui/QButton.vue'
import QCard from '../components/ui/QCard.vue'
import QField from '../components/ui/QField.vue'
import QInput from '../components/ui/QInput.vue'
import QSelect from '../components/ui/QSelect.vue'
import QSwitch from '../components/ui/QSwitch.vue'
import QTextarea from '../components/ui/QTextarea.vue'
import StatusDot from '../components/ui/StatusDot.vue'
import { useStatus } from '../composables/useStatus.js'
import { useToast } from '../composables/useToast.js'

const { status, refresh } = useStatus()
const { push } = useToast()

const appId = ref('')
const secret = ref('')
const botError = ref('')
const savingBot = ref(false)
watch(status, (s) => s?.bot && !appId.value && (appId.value = s.bot.appId), { immediate: true })

async function saveBot() {
  botError.value = ''
  if (!appId.value.trim() || !secret.value.trim()) {
    botError.value = 'AppID 与 AppSecret 都需要填写'
    return
  }
  savingBot.value = true
  try {
    await api.saveBot(appId.value.trim(), secret.value.trim())
    secret.value = ''
    await Promise.all([refresh(), loadSaved()])
    push('凭证已保存，并已向 QQ 开放平台验证通过', 'success')
  } catch (e) {
    botError.value = (e as Error).message
  } finally {
    savingBot.value = false
  }
}

// —— 换下来的机器人：换 AppID 时 Worker 把旧的存下来，这里一键切回（AppSecret 不经过面板）——

const savedBots = ref<SavedBot[]>([])
const switching = ref('')

async function loadSaved() {
  try {
    savedBots.value = (await api.savedBots()).bots
  } catch (e) {
    push(`读取已保存的机器人失败：${(e as Error).message}`, 'error')
  }
}
onMounted(loadSaved)

function botLabel(b: { appId: string; name?: string }) {
  return b.name ? `${b.name}（${b.appId}）` : b.appId
}

async function switchTo(b: SavedBot) {
  switching.value = b.appId
  try {
    await api.switchBot(b.appId)
    appId.value = b.appId
    secret.value = ''
    botError.value = ''
    await Promise.all([refresh(), loadSaved()])
    push(`已切换到 ${botLabel(b)}`, 'success')
  } catch (e) {
    push(`切换失败：${(e as Error).message}`, 'error')
  } finally {
    switching.value = ''
  }
}

async function removeSaved(b: SavedBot) {
  if (!confirm(`删除已保存的机器人 ${botLabel(b)}？只删这里存的凭证，QQ 开放平台上的机器人不受影响。`)) return
  try {
    await api.removeSavedBot(b.appId)
    await loadSaved()
    push('已删除', 'success')
  } catch (e) {
    push(`删除失败：${(e as Error).message}`, 'error')
  }
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// —— 扫码创建机器人（协议同 AstrBot）：手机 QQ 扫码即新建机器人，凭证由 Worker 解密验证后直接保存 ——

type BindState = 'idle' | 'starting' | 'pending' | 'expired' | 'created' | 'error'
const bindState = ref<BindState>('idle')
const bindQr = ref('')
const bindError = ref('')
const origin = location.origin
/** QQ 开放平台访问不到 *.workers.dev，从默认域名打开时不能把它当回调地址给出去 */
const onWorkersDev = location.hostname.endsWith('.workers.dev')
let bindTimer: ReturnType<typeof setTimeout> | undefined

function stopBind() {
  clearTimeout(bindTimer)
  bindTimer = undefined
}
onBeforeUnmount(stopBind)

async function startBind() {
  stopBind()
  bindState.value = 'starting'
  bindError.value = ''
  bindQr.value = ''
  try {
    const task = await api.startBotBind()
    bindQr.value = renderSVG(task.qrUrl, { border: 1 })
    bindState.value = 'pending'
    const poll = async () => {
      try {
        const res = await api.pollBotBind(task.taskId, task.key)
        if (res.status === 'pending') {
          bindTimer = setTimeout(poll, 2000)
          return
        }
        bindState.value = res.status
        if (res.status === 'created') {
          appId.value = res.appId ?? ''
          await Promise.all([refresh(), loadSaved()])
          push('机器人已创建，凭证已保存并验证通过', 'success')
        }
      } catch (e) {
        bindState.value = 'error'
        bindError.value = (e as Error).message
      }
    }
    bindTimer = setTimeout(poll, 2000)
  } catch (e) {
    bindState.value = 'error'
    bindError.value = (e as Error).message
  }
}

const prefixes = ref('')
const savingSnap = ref(false)
watch(
  status,
  async (s) => {
    if (!s || prefixes.value) return
    const { snapshot } = await api.snapshot()
    prefixes.value = (snapshot.commandPrefixes ?? ['/']).join(' ')
  },
  { immediate: true },
)

async function saveSnapshot(patch: { safeMode?: boolean; commandPrefixes?: string[]; admins?: string[]; permissionDeniedReply?: string }) {
  savingSnap.value = true
  try {
    const { snapshot } = await api.snapshot()
    await api.putSnapshot({ ...snapshot, ...patch })
    await refresh()
    push('已保存', 'success')
  } catch (e) {
    push(`保存失败：${(e as Error).message}`, 'error')
  } finally {
    savingSnap.value = false
  }
}

const adminsText = ref('')
const denyReply = ref('')
watch(
  status,
  async (s) => {
    if (!s || (adminsText.value || denyReply.value)) return
    const { snapshot } = await api.snapshot()
    adminsText.value = (snapshot.admins ?? []).join('\n')
    denyReply.value = snapshot.permissionDeniedReply ?? ''
  },
  { immediate: true },
)

function savePermission() {
  return saveSnapshot({
    admins: adminsText.value.split(/\s+/).filter(Boolean),
    permissionDeniedReply: denyReply.value.trim() || undefined,
  })
}

// —— QQ 指令面板与分享链接：字段按官方文档（2026-09 实测核对）——

const panelsScope = ref('group')
const panelsBody = ref('')
const panelsResult = ref('')
const panelsBusy = ref(false)

/** 把已启用插件注册的命令按官方 schema 拼成创建面板请求体；name≤14 字、desc≤30 字、最多 20 项 */
function draftPanels() {
  const items = (status.value?.plugins ?? [])
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.commands.map((c) => ({
        type: 'command',
        name: c.name.slice(0, 14),
        desc: (c.description ?? `${p.displayName || p.name} 的指令`).slice(0, 30),
        // 声明了权限的命令映射为平台原生的"仅管理员可点击"
        only_admin: c.permission === 'bot_admin' || c.permission === 'group_admin',
      })),
    )
    .slice(0, 20)
  panelsBody.value = JSON.stringify(
    {
      scope: panelsScope.value,
      target_type: 'all',
      panel: { remark: '由 qqbot-workers 面板同步', items },
    },
    null,
    2,
  )
}

async function sendPanels() {
  panelsBusy.value = true
  panelsResult.value = ''
  try {
    const res = await api.sendQQPanels(JSON.parse(panelsBody.value))
    panelsResult.value = JSON.stringify(res, null, 2)
    push(res.ok ? '指令面板已创建' : `平台返回 ${res.status}`, res.ok ? 'success' : 'error')
  } catch (e) {
    panelsResult.value = String((e as Error).message)
  } finally {
    panelsBusy.value = false
  }
}

async function viewPanels() {
  panelsBusy.value = true
  panelsResult.value = ''
  try {
    panelsResult.value = JSON.stringify(await api.qqPanels(panelsScope.value), null, 2)
  } catch (e) {
    panelsResult.value = String((e as Error).message)
  } finally {
    panelsBusy.value = false
  }
}

const urlLinkBody = ref('{}')
const urlLinkResult = ref('')
const urlLinkBusy = ref(false)

async function createLink() {
  urlLinkBusy.value = true
  urlLinkResult.value = ''
  try {
    const res = await api.createUrlLink(JSON.parse(urlLinkBody.value))
    urlLinkResult.value = JSON.stringify(res, null, 2)
    push(res.ok ? '已请求生成链接' : `平台返回 ${res.status}`, res.ok ? 'success' : 'error')
  } catch (e) {
    urlLinkResult.value = String((e as Error).message)
  } finally {
    urlLinkBusy.value = false
  }
}

// —— 自定义菜单：仅单聊场景、全局一份，PUT 整体覆盖（5 QPM）——

const menuBody = ref('')
const menuResult = ref('')
const menuBusy = ref(false)

async function viewMenu() {
  menuBusy.value = true
  menuResult.value = ''
  try {
    const res = await api.qqMenu()
    menuResult.value = JSON.stringify(res, null, 2)
    if (res.ok && (res.data as { menu?: object }).menu) menuBody.value = JSON.stringify({ menu: (res.data as { menu: object }).menu }, null, 2)
  } catch (e) {
    menuResult.value = String((e as Error).message)
  } finally {
    menuBusy.value = false
  }
}

async function saveMenu() {
  menuBusy.value = true
  menuResult.value = ''
  try {
    const res = await api.saveQQMenu(JSON.parse(menuBody.value))
    menuResult.value = JSON.stringify(res, null, 2)
    push(res.ok ? '菜单已保存' : `平台返回 ${res.status}`, res.ok ? 'success' : 'error')
  } catch (e) {
    menuResult.value = String((e as Error).message)
  } finally {
    menuBusy.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader title="设置" />
    <div class="grid gap-4 lg:grid-cols-2">
      <QCard title="机器人凭证" :description="status?.bot?.source === 'secret' ? '当前由 Worker Secret 提供，这里保存的值不会覆盖它' : '保存前会先向 QQ 开放平台换取 AccessToken 验证'">
        <div class="mb-4 flex items-center justify-between gap-3 text-sm">
          <span class="text-fg-muted">当前机器人</span>
          <StatusDot v-if="status?.bot" tone="success" :label="botLabel(status.bot)" />
          <StatusDot v-else tone="warning" label="未配置" />
        </div>
        <p v-if="status?.bot && status.bot.source !== 'secret'" class="mb-3 text-xs text-fg-muted">
          要换号就填新的 AppID 与 AppSecret 保存，或扫码新建；当前这个会自动存进下方「已保存的机器人」，之后一键切回。
        </p>
        <form class="flex flex-col gap-4" @submit.prevent="saveBot">
          <QField id="appid" label="AppID" required>
            <template #default="{ describedBy }"><QInput id="appid" v-model="appId" mono autocomplete="off" :described-by="describedBy" /></template>
          </QField>
          <QField id="secret" label="AppSecret" required :error="botError" hint="只在保存时发送一次，面板不会回显">
            <template #default="{ describedBy, invalid }"><QInput id="secret" v-model="secret" type="password" mono autocomplete="off" :described-by="describedBy" :invalid="invalid" /></template>
          </QField>
          <div class="flex gap-2">
            <QButton type="submit" variant="primary" :loading="savingBot" :disabled="status?.bot?.source === 'secret'">保存并验证</QButton>
            <QButton :loading="bindState === 'starting'" :disabled="status?.bot?.source === 'secret' || bindState === 'pending'" @click="startBind">扫码创建机器人</QButton>
          </div>
        </form>
        <div v-if="bindState !== 'idle'" class="mt-4 flex items-start gap-4 rounded-md border border-border p-3">
          <!-- eslint-disable-next-line vue/no-v-html -- SVG 由 uqr 本地生成 -->
          <div v-if="bindQr && bindState !== 'created'" class="size-36 shrink-0 rounded-md bg-white p-1" :class="{ 'opacity-30': bindState === 'expired' }" v-html="bindQr" />
          <div class="flex flex-col gap-2 text-sm">
            <p v-if="bindState === 'starting'" class="text-fg-muted">正在获取二维码…</p>
            <template v-else-if="bindState === 'pending'">
              <p class="font-medium text-fg">用手机 QQ 扫码</p>
              <p class="text-xs text-fg-muted">扫码确认后会新建一个 QQ 机器人，AppID 与 AppSecret 自动保存，不用手填。二维码约 3 分钟内有效。</p>
            </template>
            <template v-else-if="bindState === 'expired'">
              <p class="text-fg">二维码已过期</p>
              <div><QButton size="sm" @click="startBind">刷新二维码</QButton></div>
            </template>
            <template v-else-if="bindState === 'created'">
              <p class="font-medium text-fg">机器人已创建，凭证已保存</p>
              <p v-if="onWorkersDev" class="text-xs text-fg-muted">
                还差两步：先给这个 Worker 绑定自定义域名（QQ 开放平台访问不到 <code class="font-mono">*.workers.dev</code>），再到
                <a class="underline" href="https://q.qq.com" target="_blank" rel="noopener">QQ 开放平台</a> 的机器人管理里把回调地址填成
                <code class="font-mono">https://你的域名{{ status?.webhookPath ?? '/webhook' }}</code>
              </p>
              <p v-else class="text-xs text-fg-muted">
                还差一步：到 <a class="underline" href="https://q.qq.com" target="_blank" rel="noopener">QQ 开放平台</a> 的机器人管理里，把回调地址填成
                <code class="font-mono">{{ origin }}{{ status?.webhookPath ?? '/webhook' }}</code>
              </p>
            </template>
            <template v-else>
              <p class="text-danger">{{ bindError }}</p>
              <div><QButton size="sm" @click="startBind">重试</QButton></div>
            </template>
          </div>
        </div>
        <div v-if="savedBots.length" class="mt-4 border-t border-border pt-4">
          <p class="text-sm font-medium text-fg">已保存的机器人</p>
          <p class="mt-0.5 text-xs text-fg-muted">
            切回不用再填 AppSecret。切换前确认它在 QQ 开放平台的回调地址指向这里；openid 每个机器人都不一样，Bot 管理员名单要在新号下重新 /sid 查询后添加。
          </p>
          <ul class="mt-2 divide-y divide-border">
            <li v-for="b in savedBots" :key="b.appId" class="flex items-center justify-between gap-3 py-2">
              <div class="min-w-0">
                <p class="truncate text-sm text-fg">{{ b.name || '未命名机器人' }}</p>
                <p class="text-xs text-fg-muted"><span class="font-mono">{{ b.appId }}</span> · {{ fmtDate(b.savedAt) }} 换下</p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <QButton
                  size="sm"
                  :loading="switching === b.appId"
                  :disabled="status?.bot?.source === 'secret' || (!!switching && switching !== b.appId)"
                  @click="switchTo(b)"
                >切换</QButton>
                <QButton size="sm" variant="ghost" :aria-label="`删除 ${botLabel(b)}`" :disabled="!!switching" @click="removeSaved(b)">
                  <Trash2 class="size-3.5" aria-hidden="true" />
                </QButton>
              </div>
            </li>
          </ul>
        </div>
      </QCard>

      <div class="flex flex-col gap-4">
        <QCard title="运行时">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-fg">安全模式</p>
              <p class="text-xs text-fg-muted">开启后跳过全部插件，只保留验签与回调确认。排查问题时用。</p>
            </div>
            <QSwitch :model-value="status?.snapshot.safeMode ?? false" label="安全模式" :disabled="savingSnap" @update:model-value="saveSnapshot({ safeMode: $event })" />
          </div>
          <form class="mt-4 flex flex-col gap-3" @submit.prevent="saveSnapshot({ commandPrefixes: prefixes.split(/\s+/).filter(Boolean) })">
            <QField id="prefixes" label="命令前缀" hint="空格分隔，如「/ ! 。」；消息以任一前缀开头才会解析为命令">
              <template #default="{ describedBy }"><QInput id="prefixes" v-model="prefixes" mono :described-by="describedBy" /></template>
            </QField>
            <div><QButton type="submit" :loading="savingSnap">保存前缀</QButton></div>
          </form>
        </QCard>
        <QCard
          title="权限"
          description="命令可声明 permission（bot_admin / group_admin / member），达标制：上层自动通过下层门槛；按钮回调暂不鉴权"
        >
          <form class="flex flex-col gap-3" @submit.prevent="savePermission">
            <QField id="admins" label="Bot 管理员（超级管理员）" hint="一行一个用户 openid；在会话里发 /sid 可查询自己的 openid">
              <template #default="{ describedBy }"><QTextarea id="admins" v-model="adminsText" mono :rows="4" :described-by="describedBy" /></template>
            </QField>
            <QField id="denyReply" label="权限不足回复" hint="留空 = 静默跳过；填写后，权限不足且没有其他插件命中时回复此文案">
              <template #default="{ describedBy }"><QInput id="denyReply" v-model="denyReply" :described-by="describedBy" /></template>
            </QField>
            <div><QButton type="submit" :loading="savingSnap">保存权限设置</QButton></div>
          </form>
        </QCard>
        <QCard
          title="QQ 指令面板"
          description="用户点机器人看到的可点指令列表（scope 支持 c2c/group/channel/dm，一个面板最多 20 项，机器人最多 20 个面板）。声明了权限的命令会自动带上 only_admin"
        >
          <form class="flex flex-col gap-3" @submit.prevent="sendPanels">
            <QField id="panels-scope" label="生效场景">
              <template #default>
                <QSelect id="panels-scope" v-model="panelsScope" :options="[{ label: '群聊（group）', value: 'group' }, { label: '单聊（c2c）', value: 'c2c' }]" />
              </template>
            </QField>
            <QField id="panels-body" label="请求体（JSON，可编辑）">
              <template #default="{ describedBy }"><QTextarea id="panels-body" v-model="panelsBody" mono :rows="10" :described-by="describedBy" /></template>
            </QField>
            <div class="flex gap-2">
              <QButton type="button" :disabled="panelsBusy" @click="draftPanels">从已启用插件生成</QButton>
              <QButton type="button" variant="secondary" :loading="panelsBusy" @click="viewPanels">查看当前面板</QButton>
              <QButton type="submit" variant="primary" :loading="panelsBusy" :disabled="!panelsBody.trim()">发送到 QQ</QButton>
            </div>
            <pre v-if="panelsResult" class="max-h-56 overflow-auto rounded-md bg-surface p-3 font-mono text-xs text-fg-muted">{{ panelsResult }}</pre>
          </form>
        </QCard>

        <QCard title="分享链接" description="生成一条点击直达机器人会话的邀请链接（/v2/generate_url_link）；请求体字段以官方文档为准">
          <form class="flex flex-col gap-3" @submit.prevent="createLink">
            <QField id="url-link-body" label="请求体（JSON）">
              <template #default="{ describedBy }"><QTextarea id="url-link-body" v-model="urlLinkBody" mono :rows="3" :described-by="describedBy" /></template>
            </QField>
            <div><QButton type="submit" variant="primary" :loading="urlLinkBusy">生成链接</QButton></div>
            <pre v-if="urlLinkResult" class="max-h-40 overflow-auto rounded-md bg-surface p-3 font-mono text-xs text-fg-muted">{{ urlLinkResult }}</pre>
          </form>
        </QCard>

        <QCard
          title="自定义菜单"
          description="单聊会话里的快捷入口（仅单聊场景，全局一份，保存即整体覆盖）。items ≤10；type 支持 send_message / link / switch / menu（子菜单 ≤5）；name ≤10 字符。"
        >
          <form class="flex flex-col gap-3" @submit.prevent="saveMenu">
            <QField id="menu-body" label="菜单配置（JSON，可编辑）" hint="示例：{ 'menu': { 'items': [ { 'type': 'send_message', 'name': '帮助', 'send_message': '/help' } ] } }">
              <template #default="{ describedBy }"><QTextarea id="menu-body" v-model="menuBody" mono :rows="10" :described-by="describedBy" /></template>
            </QField>
            <div class="flex gap-2">
              <QButton type="button" variant="secondary" :loading="menuBusy" @click="viewMenu">查看当前菜单</QButton>
              <QButton type="submit" variant="primary" :loading="menuBusy" :disabled="!menuBody.trim()">保存到 QQ</QButton>
            </div>
            <pre v-if="menuResult" class="max-h-56 overflow-auto rounded-md bg-surface p-3 font-mono text-xs text-fg-muted">{{ menuResult }}</pre>
          </form>
        </QCard>

        <QCard title="安全建议">
          <ul class="list-disc space-y-1 pl-4 text-sm text-fg-muted">
            <li>把面板域名放到 Cloudflare Access 后面（50 用户内免费），管理密钥就成了第二道锁。</li>
            <li>轮换 <code class="font-mono text-xs">ADMIN_TOKEN</code> 会让所有会话与插件页面令牌立即失效。</li>
            <li>回调地址与面板同域，QQ 只会请求 <code class="font-mono text-xs">{{ status?.webhookPath ?? '/webhook' }}</code>，其余路径不必对外。</li>
          </ul>
        </QCard>
      </div>
    </div>
  </div>
</template>

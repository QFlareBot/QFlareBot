/** 引导结果的 Markdown 汇总：公开的 Step Summary 与向导、本地试跑用的完整版 */

import { appendFileSync } from 'node:fs'
import { BUILD_COMMAND, BUILD_PATH_EXCLUDES, DEPLOY_COMMAND } from './builds.mjs'
import { buildsConnectUrl, workerDashLink, workerDomainsUrl } from './links.mjs'

/**
 * 把引导结果渲染成 Markdown 汇总。
 *
 * publicView：写进 GITHUB_STEP_SUMMARY 用。公开仓库的 Summary 谁都能看，而且 add-mask 管不到它——
 * 所以这一版一个地址、一个标识都不写：不列面板地址与 MANIFEST_URL（都带着账户的 workers.dev 子域），
 * 后台链接用 `:account` 占位（workerDashLink），资源只说新建还是复用，不写名字与 id。
 * 完整版只给网页向导的完成页（隧道页面只有认领了的那个浏览器打得开）和本地试跑。
 */
export function renderSummary(result, { redactSecrets = false, publicView = false } = {}) {
  const {
    panelUrl,
    manifestUrl,
    buildToken,
    buildTokenReused,
    resources,
    buildsTokenWritten,
    buildsTokenExisting,
    triggerConfigured,
    redeployed,
    adminTokenKept,
    warnings,
    accountId,
    workerName,
  } = result
  const hideSecrets = redactSecrets || publicView
  const settingsLink = publicView ? workerDashLink(workerName) : buildsConnectUrl(accountId, workerName)
  const domainsLink = publicView ? workerDashLink(workerName, 'settings/triggers') : workerDomainsUrl(accountId, workerName)
  const resourceRow = (label, r) => `| ${label} | ${publicView ? '' : `${r.name}`}${r.created ? '（新建）' : '（复用已有）'} |`
  const lines = []
  lines.push(redeployed ? '## ✅ 重新部署完成' : '## ✅ 引导部署完成')
  lines.push('')
  if (redeployed) {
    lines.push(
      '这次是重跑：复用了已有的资源，D1 里装的插件按原来的版本一起重新构建；数据、自定义域名与 QQ 机器人配置都没动。' +
        '新版本走的是带健康检查的部署路径，检查不过不会上线，线上保持原来的版本。',
    )
    lines.push('')
  }
  if (publicView) {
    lines.push(
      '> 🔒 这一页谁都能看，所以不列面板地址、账户与资源标识。面板地址在 ' +
        `[Worker 后台](${domainsLink})的 Domains & Routes 里（\`${workerName}.<你的子域>.workers.dev\`）。`,
    )
    lines.push('')
  }
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  if (!publicView) {
    lines.push(`| 管理面板 | [${panelUrl}](${panelUrl}) |`)
    lines.push(`| 构建机拉清单地址（MANIFEST_URL） | \`${manifestUrl}\` |`)
  }
  if (resources.kv) lines.push(resourceRow('KV', resources.kv))
  if (resources.d1) lines.push(resourceRow('D1', resources.d1))
  if (resources.r2) lines.push(resourceRow('R2', resources.r2))
  lines.push('')
  lines.push(
    adminTokenKept
      ? '**面板登录**：沿用原来的 `ADMIN_TOKEN`，这次没改，已经登录的会话照常有效。'
      : '**面板登录**：用你自己设置的 `ADMIN_TOKEN`（无 UI 模式是 GitHub Secret 里那个，网页向导是表单里填的）。' +
          '引导不会生成、也不会在任何地方输出它；忘了就 `wrangler secret put ADMIN_TOKEN` 重设。',
  )
  lines.push('')
  lines.push('### 下一步')
  lines.push('')
  if (redeployed) {
    lines.push('之前绑的域名、建的机器人、连好的仓库都还在，下面做过的不用重做。')
    lines.push('')
  }
  // 域名由用户自己选、自己绑：引导不接收域名，部署也不声明 routes，绑上之后不会被任何部署路径改动。
  // 回调地址只给域名模板，不给 workers.dev 的——QQ 开放平台验证不通 *.workers.dev（已实测），给了只会让人白填一次
  lines.push(
    `1. **绑定自定义域名（必需）**：QQ 开放平台访问不到 \`*.workers.dev\`，回调必须走你自己的域名。` +
      `打开 [Cloudflare 域名设置页](${domainsLink})，在 **Custom Domains** 里添加一个` +
      '（域名要托管在这个 Cloudflare 账户下，如 `bot.yourdomain.com`）。之后的部署都不会改动你绑的域名。',
  )
  lines.push('')
  lines.push(
    '2. **创建或绑定 QQ 机器人**：用新域名打开面板，到「设置」里用手机 QQ 扫码新建一个，或填入已有机器人的 AppID / AppSecret。' +
      '然后在 [q.qq.com](https://q.qq.com) 机器人管理里把回调地址填成 `https://你的域名/webhook`（面板概览页可以一键复制）。',
  )
  lines.push('')
  if (triggerConfigured) {
    lines.push(
      `3. **构建配置已自动写入**：Build command、Deploy command、\`MANIFEST_URL\`、\`MANIFEST_TOKEN\`、排除路径与构建缓存都已经通过 Builds API ` +
        `写进了这个 Worker 的构建 trigger，[后台](${settingsLink})一个格子都不用填。到面板装一个插件即可验证重建链路。`,
    )
  } else {
    lines.push(
      `3. **连接仓库**（装/卸插件触发重建的前置）：打开 [Worker 设置页](${settingsLink})，在 Build 一栏点 Connect，` +
        '选择本 fork 仓库，分支选默认分支，然后照抄下面几项。' +
        '（网页向导模式会在连接完成后自动写入，不必手抄；这里是无 UI 模式的兜底——' +
        '工作流跑的时候仓库还没连接，trigger 不存在，写不了。配好 `CF_BUILDS_TOKEN` 后，Worker 第一次从面板触发构建时也会自动补写。）',
    )
    lines.push('')
    lines.push('   ```')
    lines.push('   # Build command')
    lines.push(`   ${BUILD_COMMAND}`)
    lines.push('   # Deploy command')
    lines.push(`   ${DEPLOY_COMMAND}`)
    lines.push('   # Build watch paths → Exclude paths（只改这些时不重建机器人）')
    lines.push(`   ${BUILD_PATH_EXCLUDES.join('  ')}`)
    lines.push('   # Settings → Build → Build cache → Enable（可选：缓存下载的依赖，装依赖快一些）')
    lines.push('   # 环境变量（Settings → Builds → Environment variables）')
    lines.push(`   MANIFEST_URL=${publicView ? `https://${workerName}.<你的子域>.workers.dev/admin/build-manifest` : manifestUrl}`)
    // Worker 侧叫 BUILD_TOKEN、构建机侧叫 MANIFEST_TOKEN，是同一个值——名字不一致最容易配错
    const manifestToken = buildTokenReused
      ? '<与 Worker 上已有的 BUILD_TOKEN 同值，见下>'
      : hideSecrets
        ? '<引导自动生成的 BUILD_TOKEN，见下>'
        : buildToken
    lines.push(`   MANIFEST_TOKEN=${manifestToken}`)
    lines.push('   ```')
    if (buildTokenReused) {
      lines.push('')
      lines.push(
        '   🔑 Worker 上已有 `BUILD_TOKEN`，本次沿用、没有轮换——构建机侧已经填好的 `MANIFEST_TOKEN` 保持不动即可。' +
          '还没填过的话：`wrangler secret put BUILD_TOKEN` 重设一个随机长字符串，再把 `MANIFEST_TOKEN` 填成同一个值。',
      )
    } else if (hideSecrets) {
      lines.push('')
      lines.push(
        '   🔑 `BUILD_TOKEN` 由引导自动生成并写入 Worker，为避免公开日志泄露没有打印在这里。' +
          '取值：Cloudflare 控制台看不到 secret 明文，直接 `wrangler secret put BUILD_TOKEN` 重设一个随机长字符串，' +
          '再把构建机侧的 `MANIFEST_TOKEN` 填成同一个值即可。',
      )
    }
  }
  if (buildsTokenWritten) {
    lines.push('')
    lines.push('   构建凭证 `CF_BUILDS_TOKEN` 已写入 Worker，装插件时自动触发重建；token 带 Workers Observability 编辑权限时，面板概览还能读到最近事件。')
  } else if (buildsTokenExisting) {
    lines.push('')
    lines.push('   构建凭证 `CF_BUILDS_TOKEN` 沿用 Worker 上已有的那个（这次没换）。之后面板装插件时提示它失效了，再重新建一个写入即可。')
  } else {
    lines.push('')
    lines.push('   **尚未配置 `CF_BUILDS_TOKEN`**（Worker 触发重建、面板读最近事件用）：创建一个 user token（权限：Workers Builds Configuration Edit + Workers Scripts Read + Workers Observability Edit，账户范围限本账户），`wrangler secret put CF_BUILDS_TOKEN` 写入，或重跑引导时带上。配置后到面板装一个插件即可验证重建链路。')
  }
  lines.push('')
  if (warnings.length) {
    lines.push('### ⚠️ 提醒')
    lines.push('')
    for (const w of warnings) lines.push(`- ${w}`)
    lines.push('')
  }
  lines.push('> 幂等：本工作流可随时重跑。重跑会复用同名资源，带上 D1 里已安装的插件，沿用已有的 BUILD_TOKEN。')
  lines.push('')
  return lines.join('\n')
}

/** 把 Markdown 追加到 GITHUB_STEP_SUMMARY（存在时） */
export function appendStepSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
}

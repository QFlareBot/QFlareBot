---
description: 想让插件用上大模型，装 LLM 接口插件；Agent 插件是一个现成的消费方，可以拿来用，也可以自己写。
---

# AI 能力：LLM 接口插件

机器人本身不含任何模型接入。谁需要 AI 能力（对话、总结、改写、生成），就装 **LLM 接口**插件，通过它提供的 `llm` 服务调用模型。

- **LLM 接口**（`llm`）：供应商与模型别名管理 + 统一的 `chat` / `stream` 接口。它是**能力提供方**，所有要用模型的插件都依赖它。
- **Agent**（`agent`）：一个**消费方示范**——拿 `llm` 服务做多轮对话、工具调用、会话记忆。它证明这套接口够用，但不是我方提供的唯一形态；有人想做一个更好的 Agent、甚至换个方向（翻译、审稿、群管助手），直接照着 `llm` 的接口写自己的插件即可，不需要跟 Agent 插件绑在一起。

两者都**不是**内置插件（[内置插件](./builtin-plugins)只有 `sid` 和 `t2i`），在[插件市场](./market)单独安装、单独升级。

## 装 LLM 接口

`llm` 没有硬依赖，装完配好就能被别的插件用。仓库：[qflarebot-plugin-llm](https://github.com/clown145/qflarebot-plugin-llm)。

配好只需要一次：

1. 侧栏「插件页面 → LLM 接口」→「模型服务」左侧点「添加」，选一个服务商模板（OpenAI 兼容或 Anthropic），填 API Key 保存。
2. 点「刷新上游」读接口的模型列表，用「+」逐个添加或「全部添加」；也可以「添加模型」手填上游模型名，**别名**供调用方使用。
3. 在「设置」里选默认模型别名和超时，点「保存设置」。
4. 「概览」里执行一次测试，确认地址、Key、模型都通。

几点要知道的：

- **配置只在插件页面改，不在面板的「插件配置」卡片里**。这个插件没有声明 `configSchema`，那张卡片对它是摆设，写进去的值不会被读取，而且字段不脱敏——**不要往那里写 API Key**。
- API Key 存在插件自己的 KV 里，接口只回「已设置」的布尔值，页面不回显；导出的 JSON 不含 Key。
- 接口地址只接受 `https`，并拒绝回环与内网地址。不要在「额外请求头」里写 `Authorization` / `x-api-key`，这两个头由插件按 Key 生成。
- 模型元数据可以从 [models.dev](https://models.dev) 按需填充，运行时不会去请求它。
- 群里发 `/llm` 查看当前模型与可用列表，`/llm use <序号或别名>` 切换**全局默认**（不是按会话）。

## 在自己的插件里用模型

声明依赖，然后从 `ctx.service('llm')` 取：

```ts
export default definePlugin({
  depends: { llm: '*' },   // 必需；想「没装也能跑」就写 'optional'
  commands: {
    summarize: async ({ ctx, argText }) => {
      const llm = ctx.service<LLMService>('llm')
      const result = await llm.chat({
        model: 'chat',   // 模型别名；省略则用 LLM 页面里设的默认模型
        messages: [
          { role: 'system', content: '把用户给的内容压缩成一句话。' },
          { role: 'user', content: argText },
        ],
      })
      return result.text ?? '模型没有返回内容'
    },
  },
})
```

接口是 `listModels` / `resolve` / `chat` / `stream` / `ping`，完整类型见插件仓库的 `src/contract.ts`。`LLMService` 这类类型不在 `@qqbot/sdk` 里，复制一份到自己的插件（Agent 插件就是本地复制了一份最小定义），**不要** import 对方的源码——那是构建期依赖，插件之间只该通过服务名对接。几个规则：

- **调用方按别名要模型，不写供应商或上游模型名**。用户换供应商、换模型时，插件不用改。
- 服务名就是接口约定。接口要改会换服务名（`llm2`），不会原地改形状。
- `depends` 写 `'*'` 是硬依赖：没装 LLM 时安装会被直接拒绝，不会装上一个跑不起来的插件。想要「有就用、没有就降级」就写 `'optional'`，取不到时 `ctx.service()` 会抛错，自己 `try/catch`。
- **免费版的额度是全机器人共享的**：一次事件所有插件合计 30 秒、50 个子请求，CPU 共 10 ms。模型请求本身就占一个子请求、几百毫秒到几十秒，所以**别在每条消息都会走到的路径上调模型**，也别为了一条消息连调好几次。

## Agent：一个现成的消费方

[qflarebot-plugin-agent](https://github.com/clown145/qflarebot-plugin-agent) 是 `llm` 服务的一个**示范消费方**：多轮对话、工具调用、会话记忆、定时提醒。它说明这套接口能撑到什么程度，但不是我方提供的唯一形态，也不限制别人怎么做。

想直接用：先装 `llm` 再装 `agent`（市场里两个一起勾会自动按依赖顺序写清单），然后在侧栏「插件页面 → Agent」选一个模型别名、点「测试连通性」即可。群里 @机器人 或打 `/` 前缀都能触发，`/help` 看全部命令。它声明了 DO 类，面板预检会给一句提醒，**不需要**改 `apps/seed/wrangler.jsonc`。

想做更好的、或者换个方向（翻译、审稿、群管助手），直接照 `llm` 的接口写自己的插件就行，不必和 Agent 绑定。

### 自己写的话，先看额度

欢迎做更好的实现，但请先算一笔账——下面几项是**全机器人共享**的（免费版），一个 AI 插件把额度吃光，整台机器人一起停摆：

| 资源 | 免费版额度 | 对 AI 插件意味着什么 |
| --- | --- | --- |
| D1 写入 | 10 万行/天 | 不要每条消息都写一行，审计/统计这类要么关掉、要么攒批 |
| KV | 写/删/列各 1,000 次/天 | 只存配置这类很少变的东西；计数与会话状态放 D1 或 DO |
| Durable Object | 13,000 GB-s/天 | 按「128 MB × 活跃时长」计费，**一个被持续访问的 DO 一天约 11,000 GB-s**，几乎吃掉全额度 |
| 子请求 | 50 次/事件 | 一次模型调用就是一个子请求；工具调用会再连锁几个，要自己数 |
| CPU | 10 ms/事件 | 大 JSON 解析、长循环、base64 编码都别放热路径 |
| 请求数 | 10 万次/天 | 声明 `* * * * *` 的 cron 跟着框架那个每分钟触发器跑，一天先占 1,440 次 |

Agent 为压住这些做过的取舍（会话状态与会话锁放 DO、限流计数放 DO、审计默认关、工具步数默认 8）可以对着看。完整限额表见[插件开发指南 · 平台限额](./plugin-guide#_9-平台限额-免费版的硬预算)。

## 更多文档

| 文档 | 内容 |
| --- | --- |
| [LLM 接口 README](https://github.com/clown145/qflarebot-plugin-llm) | 供应商模板、请求头、模型元数据、`llm` 服务接口与 `contract.ts` |
| [Agent 快速开始](https://github.com/clown145/qflarebot-plugin-agent/blob/main/docs/quickstart.md) | 装、配、跑起来 |
| [Agent 配置说明](https://github.com/clown145/qflarebot-plugin-agent/blob/main/docs/configuration.md) | 每个配置项的含义与取舍 |
| [Agent 工具与权限](https://github.com/clown145/qflarebot-plugin-agent/blob/main/docs/tools.md) | 工具清单、权限怎么算、安全防线 |
| [Agent 插件 API](https://github.com/clown145/qflarebot-plugin-agent/blob/main/docs/plugin-api.md) | 用 `ctx.service('agent')` 往 Agent 里注册提示词片段与工具 |

想让自己的插件也对外提供服务、给别的插件用，看[插件开发指南 · 要读别的插件的数据](./plugin-guide#要读别的插件的数据)。

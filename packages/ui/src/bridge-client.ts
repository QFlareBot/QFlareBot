/**
 * 独立入口，构建为稳定文件名 /bridge.js（ES 模块）。
 * 插件页面 `import { createBridge } from '/bridge.js'` 即可，客户端协议版本永远与面板一致；
 * 同时挂到 window.qqbotBridge 供不写模块脚本的页面使用。
 */
import { createBridge } from '@qqbot/ui-bridge'

declare global {
  interface Window {
    qqbotBridge: { createBridge: typeof createBridge }
  }
}

window.qqbotBridge = { createBridge }
export { createBridge }

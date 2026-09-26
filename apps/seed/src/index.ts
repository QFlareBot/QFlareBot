/**
 * 本地开发 / 静态入口：直接 import 工作区里的插件。
 * 线上部署走 `pnpm project` 生成的 dist/index.js（由清单投影而来），两者形状一致。
 */
import { createRuntime } from '@qqbot/runtime'
import ui from '@qqbot/ui'
import echo from 'qflarebot-plugin-echo'
import image from 'qflarebot-plugin-image'
import keyboard from 'qflarebot-plugin-keyboard'
import multiReply from 'qflarebot-plugin-multi-reply'
import sid from 'qflarebot-plugin-sid'
import t2i from 'qflarebot-plugin-t2i'

export default createRuntime({
  plugins: [echo, multiReply, image, t2i, keyboard, sid],
  ui,
})

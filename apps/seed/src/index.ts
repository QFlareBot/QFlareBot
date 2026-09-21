/**
 * 本地开发 / 静态入口：直接 import 工作区里的插件。
 * 线上部署走 `pnpm project` 生成的 dist/index.js（由清单投影而来），两者形状一致。
 */
import { createRuntime } from '@qqbot/runtime'
import ui from '@qqbot/ui'
import echo from 'qqbot-plugin-echo'
import image from 'qqbot-plugin-image'
import keyboard from 'qqbot-plugin-keyboard'
import multiReply from 'qqbot-plugin-multi-reply'
import sid from 'qqbot-plugin-sid'
import t2i from 'qqbot-plugin-t2i'

export default createRuntime({
  plugins: [echo, multiReply, image, t2i, keyboard, sid],
  ui,
})

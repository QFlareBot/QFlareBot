/** Cloudflare Quick Tunnel：把本地向导服务暴露成一个随机的 trycloudflare.com 地址 */

import { spawn } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CLOUDFLARED_VERSION, downloadCloudflared } from '../lib.mjs'
import { log } from './log.mjs'

export async function startTunnel(port) {
  if (process.platform !== 'linux') {
    log('非 Linux 环境（本地试跑）：跳过 Quick Tunnel，直接用本地地址')
    return `http://127.0.0.1:${port}`
  }
  const binary = path.join(os.tmpdir(), 'cloudflared')
  log(`下载 cloudflared ${CLOUDFLARED_VERSION}…`)
  // 钉死版本并核对 sha256，对不上就不写文件、不运行（见 lib/cloudflared.mjs）
  const buf = await downloadCloudflared()
  await writeFile(binary, buf)
  await chmod(binary, 0o700)

  return new Promise((resolveTunnel, rejectTunnel) => {
    const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      cleanup()
      rejectTunnel(new Error('等待 trycloudflare 地址超时（90秒）'))
    }, 90 * 1000)

    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
    }

    const onData = (chunk) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(String(chunk))
      if (match) {
        cleanup()
        child.stdout.resume()
        child.stderr.resume()
        log('Quick Tunnel 就绪')
        resolveTunnel(match[0])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      cleanup()
      rejectTunnel(new Error(`cloudflared 提前退出（${code}）`))
    })
  })
}

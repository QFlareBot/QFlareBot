import type { SendResult, StreamChunkOptions, StreamWriter } from '@qqbot/sdk'

const THROTTLE_MS = 500
const buffered = (): SendResult => ({ ok: true, status: 0, raw: null })
type SendChunk = (content: string, options: Pick<StreamChunkOptions, 'streamId' | 'index' | 'final'>) => Promise<SendResult>

/** 同时只发一片；调用方负责为整个流保留一个 msg_seq。没有单聊发送器时在 end 汇总回复。 */
export function createStreamWriter(send: SendChunk | undefined, reply: (content: string) => Promise<SendResult>): StreamWriter {
  let pending: string[] = []
  let index = 0
  let streamId: string | undefined
  let lastStarted: number | undefined
  let sending: Promise<SendResult> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failure: SendResult | undefined
  let closed = false
  let ending: Promise<SendResult> | undefined

  function schedule(): void {
    if (!send || closed || failure || sending || timer !== undefined || !pending.length) return
    const delay = lastStarted === undefined ? 0 : Math.max(0, lastStarted + THROTTLE_MS - Date.now())
    timer = setTimeout(() => {
      timer = undefined
      // flush 把异常保存在 failure，后续 write/end 会返回它；end 也会等待正在发出的分片。
      void flush(false)
    }, delay)
  }

  function flush(final: boolean): Promise<SendResult> {
    const content = pending.join('')
    pending = []
    if (failure) return Promise.resolve(failure)
    if (!content && !streamId) return Promise.resolve(buffered())
    lastStarted = Date.now()
    const task = (async (): Promise<SendResult> => {
      let result: SendResult
      try {
        result = await send!(content, { index, final, ...(streamId ? { streamId } : {}) })
        if (result.ok && !streamId && !result.messageId) {
          result = { ...result, ok: false, error: '流式首片未返回消息 ID，已停止发送' }
        }
      } catch (error) {
        result = { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), raw: null }
      }
      if (result.ok) {
        streamId ??= result.messageId
        index += 1
      } else {
        // 失败时不跳号、不补发后续 delta，避免首片缺失或网络结果不明时出现重复正文。
        failure = result
        pending = []
      }
      return result
    })()
    sending = task
    void task.then(() => {
      sending = undefined
      schedule()
    })
    return task
  }

  return {
    get messageId() {
      return streamId
    },
    async write(chunk) {
      if (closed) return { ok: false, status: 0, error: '流式消息已结束，不能继续写入', raw: null }
      if (failure) return failure
      if (!chunk) return buffered()
      pending.push(chunk)
      if (send && !sending && (lastStarted === undefined || Date.now() - lastStarted >= THROTTLE_MS)) {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        return flush(false)
      }
      schedule()
      return buffered()
    },
    end(chunk) {
      if (ending) return ending
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (chunk) pending.push(chunk)
      ending = (async () => {
        if (sending) await sending
        if (failure) return failure
        if (send) return flush(true)
        const content = pending.join('')
        pending = []
        return content ? reply(content) : buffered()
      })()
      return ending
    },
  }
}

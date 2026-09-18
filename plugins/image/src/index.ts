import { definePlugin } from '@qqbot/sdk'

// 64x64 测试 PNG（136 字节）
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAADFBMVEUAcPP///8QuYEPFypTAqG/AAAAN0lEQVR42u3XsQ0AIBADsSD235kJaKD7+AZwGyX7swwB8hgAAJgPrEsAAAAA6ARsIwDQC5R/5wPGow2B5rHBrAAAAABJRU5ErkJggg=='

export default definePlugin({
  name: 'image',
  displayName: '图片',
  description: '发送图片：不带参数发内置测试图，带 URL 则发该图片',
  permissions: ['net'],

  commands: {
    image: {
      aliases: ['图片', 'pic'],
      usage: '/image [图片 URL]',
      handler: ({ args }) => {
        const url = args.find((a) => /^https?:\/\//i.test(a))
        return url ? { image: { url } } : { text: '这是内置测试图片', image: { base64: TEST_PNG_BASE64 } }
      },
    },
  },

  routes: [
    {
      method: 'GET',
      path: '/test.png',
      async handler() {
        const bytes = Uint8Array.from(atob(TEST_PNG_BASE64), (c) => c.charCodeAt(0))
        return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } })
      },
    },
  ],
})

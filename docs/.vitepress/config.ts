import { defineConfig } from 'vitepress'

const repo = 'https://github.com/QFlareBot/QFlareBot'

// 站点发布在 qflarebot.github.io 根路径，不需要 base
export default defineConfig({
  lang: 'zh-CN',
  title: 'QFlareBot',
  description: '运行在 Cloudflare Workers 上的 QQ 官方机器人插件框架',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '快速部署', link: '/deploy' },
      { text: '插件开发', link: '/plugin-guide' },
      { text: '插件市场', link: '/market' },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '快速部署', link: '/deploy' },
          { text: '绑定自定义域名', link: '/deploy-domain' },
          { text: '配置 QQ 开放平台', link: '/deploy-qq' },
        ],
      },
      {
        text: '使用',
        items: [
          { text: '内置插件', link: '/builtin-plugins' },
          { text: '升级与运维', link: '/maintenance' },
        ],
      },
      {
        text: '插件开发',
        items: [
          { text: '插件开发指南', link: '/plugin-guide' },
          { text: '平台能力对照', link: '/capabilities' },
          { text: '面板与插件页面', link: '/ui' },
          { text: '发布插件', link: '/publish' },
          { text: '插件市场', link: '/market' },
        ],
      },
      {
        text: '深入',
        items: [
          { text: '设计决策', link: '/design' },
          { text: '参与开发', link: '/development' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: '在 GitHub 上编辑此页' },
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          // MiniSearch 默认按空格和标点切词，一整句中文成了一个词，只有句首的词搜得到。
          // 改用 Intl.Segmenter 按词切；建索引（Node）和搜索（浏览器）用的是同一个函数。
          // 函数会被 VitePress 序列化进客户端，必须自包含，不能引用外部变量。
          options: {
            tokenize: (text: string) =>
              [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)]
                .filter((s) => s.isWordLike)
                .map((s) => s.segment),
          },
          // 中文查询会被切成多个词，默认的 OR 会把只命中一个字词的页面都列出来
          searchOptions: { combineWith: 'AND' },
        },
      },
    },
    outline: { level: [2, 3], label: '本页目录' },
    lastUpdated: { text: '最后更新' },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    footer: { message: '框架以 GPL-3.0-or-later 发布，SDK、插件模板与内置插件以 MIT 发布' },
  },
})

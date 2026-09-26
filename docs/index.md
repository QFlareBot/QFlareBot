---
layout: home

hero:
  name: QFlareBot
  text: 跑在 Cloudflare Workers 上的 QQ 机器人
  tagline: 零服务器、Fork 即部署、面板装插件
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: QFlareBot
  actions:
    - theme: brand
      text: 快速部署
      link: /deploy
    - theme: alt
      text: 写插件
      link: /plugin-guide
    - theme: alt
      text: GitHub
      link: https://github.com/QFlareBot/QFlareBot

features:
  - title: 零服务器
    details: 走 QQ 开放平台 Webhook，一个 Worker 就是一个常驻在线的机器人，无需 IP 白名单。
  - title: Fork 即部署
    details: Bootstrap 工作流的网页向导一次建好 KV / D1 / R2 并完成首次部署。
  - title: 面板装插件
    details: 粘贴仓库链接即可安装、批量更新、卸载；插件在 Workers Builds 上从源码构建，构建失败时线上保持原版本。
  - title: 插件契约
    details: TypeScript 编写，支持命令、正则、事件、按键回调与定时任务；KV / D1 / R2 按插件隔离；插件可以自带 Web 页面和 HTTP 接口。
  - title: 升级就是同步上游
    details: 在 Fork 上点 Sync fork，机器人自动重建，面板里装的插件都还在。
  - title: 管理面板
    details: 插件开关与配置、事件模拟器、扫码创建机器人、插件自定义页面。
---

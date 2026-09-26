#!/usr/bin/env node
/**
 * QFlareBot 标志：粗圆环（Q / 聊天气泡）+ 右下尖角（Q 的尾巴 / 气泡尖角）+ 右上火花（Flare）。
 * 64×64 网格；火花与圆环之间的缝隙用蒙版挖出来，放在任何底色上都成立。
 *
 * 这个文件是唯一的来源：改图形或颜色只改这里，然后重新导出。
 *
 *   node design-system/qflarebot/brand/export.mjs
 *
 * SVG 不需要依赖。PNG（头像、分享卡片、apple-touch-icon）要 @resvg/resvg-js，仓库不装它：
 *
 *   npm i --prefix /tmp/resvg @resvg/resvg-js@2
 *   RESVG_DIR=/tmp/resvg node design-system/qflarebot/brand/export.mjs
 *
 * 分享卡片的文字用系统字体（PingFang SC / Hiragino Sans GB），在 macOS 上导出。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')

const INK = { light: '#0F172A', dark: '#F8FAFC' }
const FLARE = { light: '#16A34A', dark: '#22C55E' }
const BG = { light: '#F8FAFC', dark: '#020617' }

const SPARK = 'M47 4Q48.6 14.4 59 16 48.6 17.6 47 28 45.4 17.6 35 16 45.4 14.4 47 4Z'
const GAP = 5 // 火花外那圈缝隙：蒙版里火花外扩的描边宽度

/** 图形本体；ink / flare 是颜色属性片段，便于换成固定色或 class */
function body({ inkStroke, inkFill, flare, id = 'qfb-gap' }) {
  return [
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">`,
    `<rect width="64" height="64" fill="#fff"/>`,
    `<path d="${SPARK}" fill="#000" stroke="#000" stroke-width="${GAP}" stroke-linejoin="round"/>`,
    `</mask>`,
    `<g mask="url(#${id})">`,
    `<circle cx="29" cy="34" r="18" fill="none" ${inkStroke} stroke-width="11"/>`,
    `<path d="M50.3 43.9 55 59 38.9 55.3 38.2 43.2Z" ${inkFill}/>`,
    `</g>`,
    `<path d="${SPARK}" ${flare}/>`,
  ].join('')
}

const solid = (theme, id) =>
  body({ inkStroke: `stroke="${INK[theme]}"`, inkFill: `fill="${INK[theme]}"`, flare: `fill="${FLARE[theme]}"`, id })

const svg = (inner, attrs = 'viewBox="0 0 64 64"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>\n`

// 跟随系统深浅色的版本：标签页图标用
const favicon = svg(
  `<style>.s{stroke:${INK.light}}.i{fill:${INK.light}}.f{fill:${FLARE.light}}` +
    `@media (prefers-color-scheme:dark){.s{stroke:${INK.dark}}.i{fill:${INK.dark}}.f{fill:${FLARE.dark}}}</style>` +
    body({ inkStroke: 'class="s"', inkFill: 'class="i"', flare: 'class="f"' }),
)

/**
 * 贴纸版：透明底，图形外面包一圈白边，放在 GitHub 深浅两种页面上都看得清。
 * 白边画在图形下面：把圆环、尖角、火花各自外扩 OUTLINE，火花与圆环之间的缝隙也被填白。
 */
const OUTLINE = 3.5
function sticker() {
  const w = OUTLINE * 2
  return (
    `<g fill="#fff" stroke="#fff" stroke-linejoin="round">` +
    `<circle cx="29" cy="34" r="18" fill="none" stroke-width="${11 + w}"/>` +
    `<path d="M50.3 43.9 55 59 38.9 55.3 38.2 43.2Z" stroke-width="${w}"/>` +
    `<path d="${SPARK}" stroke-width="${w}"/>` +
    `</g>` +
    solid('light')
  )
}

/** 方形带底色：mark 占边长的 ratio */
function tile(size, theme, ratio) {
  const m = size * ratio
  const o = (size - m) / 2
  return svg(
    `<rect width="${size}" height="${size}" fill="${BG[theme]}"/>` +
      `<svg x="${o}" y="${o}" width="${m}" height="${m}" viewBox="0 0 64 64">${solid(theme)}</svg>`,
    `width="${size}" height="${size}"`,
  )
}

// 仓库分享卡片（GitHub 建议 1280×640，四周留 40px 以上）
const FONT = `font-family="PingFang SC, Hiragino Sans GB, sans-serif"`
const social = svg(
  `<rect width="1280" height="640" fill="${BG.light}"/>` +
    `<svg x="120" y="180" width="280" height="280" viewBox="0 0 64 64">${solid('light')}</svg>` +
    `<text x="460" y="300" ${FONT} font-size="104" font-weight="600" fill="${INK.light}">QFlareBot</text>` +
    `<text x="464" y="372" ${FONT} font-size="34" fill="#475569">跑在 Cloudflare Workers 上的 QQ 机器人</text>` +
    `<text x="464" y="430" ${FONT} font-size="28" fill="#15803D">零服务器 · Fork 即部署 · 面板装插件</text>`,
  'width="1280" height="640"',
)

const outputs = {
  // 母版
  'design-system/qflarebot/brand/logo.svg': svg(solid('light')),
  'design-system/qflarebot/brand/logo-dark.svg': svg(solid('dark')),
  'design-system/qflarebot/brand/favicon.svg': favicon,
  // 文档站（VitePress public 目录）
  'docs/public/logo.svg': svg(solid('light')),
  'docs/public/logo-dark.svg': svg(solid('dark')),
  'docs/public/favicon.svg': favicon,
  // 管理面板
  'packages/ui/public/favicon.svg': favicon,
}

const pngs = {
  // 组织头像：透明底 + 白边；白边外扩后图形占满 64 网格，四周只留一点余量
  'design-system/qflarebot/brand/avatar.png': svg(
    `<svg x="16" y="16" width="480" height="480" viewBox="0 0 64 64">${sticker()}</svg>`,
    'width="512" height="512"',
  ),
  'design-system/qflarebot/brand/social-preview.png': social,
  'docs/public/apple-touch-icon.png': tile(180, 'light', 0.7),
  'packages/ui/public/apple-touch-icon.png': tile(180, 'light', 0.7),
}

function write(rel, data) {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log(`  ${rel}`)
}

console.log('SVG：')
for (const [rel, data] of Object.entries(outputs)) write(rel, data)

let Resvg
try {
  const base = process.env.RESVG_DIR ? path.join(path.resolve(process.env.RESVG_DIR), 'noop.js') : import.meta.url
  ;({ Resvg } = createRequire(base)('@resvg/resvg-js'))
} catch {
  console.log('\n没找到 @resvg/resvg-js，跳过 PNG。安装方法见文件头部注释。')
  process.exit(0)
}
console.log('PNG：')
for (const [rel, data] of Object.entries(pngs)) {
  write(rel, new Resvg(data, { font: { loadSystemFonts: true } }).render().asPng())
}

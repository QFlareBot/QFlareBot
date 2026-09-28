import { redactIds } from '../lib.mjs'

/**
 * 向导自己的日志行。一律过一遍 redactIds：写配置失败、触发构建失败、查构建状态失败时带的报错
 * 可能夹着 trigger / build uuid 之类事先没法 add-mask 的标识。向导网址（带 sid）不走这里，见 wizard.mjs。
 */
export function log(line) {
  console.log(`[wizard] ${redactIds(line)}`)
}

/** 让 Actions 在之后的日志里把这个值打成 `***` */
export function mask(value) {
  if (value) console.log(`::add-mask::${value}`)
}

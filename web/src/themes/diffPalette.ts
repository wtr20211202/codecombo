import type { DiffPalette } from '../stores/font'

/**
 * diff 色板解析（P-20261006-5）：色弱友好档的可访问性色板——CSS 变量对
 * （--diff-added/--diff-removed）与 Monaco diffEditor 颜色的单点取值源。
 *
 * 档位语义：standard = 现状红绿；colorblind = 蓝/橙替代（deuteranopia-safe
 * 业界标准组合）。每主题在 colors 表存两档共四键（diff-added/diff-removed 为
 * 标准档、*-cb 后缀为色弱档，均为 hex 字面量）——diff 专用变量不混用全局语义色
 * （accent-green 同时承载成功语义、accent-red 承载失败语义，档位切换若指过去
 * 会涟漪到非 diff 面），主题气质微调也只动 themes/*.ts 一处。
 *
 * 消费方：stores/theme.ts apply()（CSS 变量按档写入）、themes/early-init.ts
 * （mount 前首帧同源）、utils/monaco-theme.ts（Monaco 颜色注入）。
 */

/** 从主题 colors 解析当前档位的 diff 语义色对。缺键回空串（parity 单测保证
 *  六主题四键齐备，空串仅防御测试桩等非注册表形态） */
export function resolveDiffPair(colors: Record<string, string>, palette: DiffPalette): { added: string; removed: string } {
  const added = palette === 'colorblind' ? colors['diff-added-cb'] : colors['diff-added']
  const removed = palette === 'colorblind' ? colors['diff-removed-cb'] : colors['diff-removed']
  return { added: added ?? '', removed: removed ?? '' }
}

/** 色弱档 Monaco diffEditor 颜色覆盖：四背景键按色弱对派生（alpha 梯度沿各主题
 *  标准档「词条 40 / 整行 30」惯例）+ 内联词条边框（标准档无边框，色弱档补一条
 *  弱边框作非色彩线索——hue 区分之外的第二辨认通道）。标准档不调用本函数，
 *  monacoColors 原值零触碰（存量外观逐像素不变） */
export function colorblindMonacoOverrides(pair: { added: string; removed: string }): Record<string, string> {
  return {
    'diffEditor.insertedTextBackground': pair.added + '40',
    'diffEditor.removedTextBackground': pair.removed + '40',
    'diffEditor.insertedLineBackground': pair.added + '30',
    'diffEditor.removedLineBackground': pair.removed + '30',
    'diffEditor.insertedTextBorder': pair.added + '66',
    'diffEditor.removedTextBorder': pair.removed + '66',
  }
}

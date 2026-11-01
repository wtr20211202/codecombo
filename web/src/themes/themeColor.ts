import type { ThemeDefinition } from './index'

/**
 * 把主题主形态色（bg-primary）同步到 <meta name="theme-color">（P-20261004-134）：
 * 安装态（PWA standalone）下移动端状态栏/标题栏色随主题联动，浏览器标签态则是
 * Chrome 移动端地址栏着色。meta 在 index.html 静态声明深色默认值（JS 未跑的
 * 首帧可见），本函数只做同步更新——深浅主题均取 bg-primary 字面量
 * （六主题该键均为十六进制字面量，无 var() 间接引用，可直接写入 meta）。
 */
export function applyThemeColorMeta(theme: ThemeDefinition): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  const color = theme.colors['bg-primary']
  if (meta && color) meta.setAttribute('content', color)
}

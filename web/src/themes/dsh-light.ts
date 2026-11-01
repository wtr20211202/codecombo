import type { GlobalThemeOverrides } from 'naive-ui'
import type { ThemeDefinition } from './index'

/**
 * DeepSeek Light：与 dsh 官方浅色主题观感对齐（纯白画布、近黑正文、
 * DeepSeek 蓝 #3b6ad6 强调——P-20261019-4 由 #4176e6 微调深度以让反白
 * 按钮/徽标达到 WCAG 常规字号 4.5:1）。选此主题 + dsh 内选「浅色」即两侧
 * 观感一致，无需任何注入/滤镜。
 */
export const dshLight: ThemeDefinition = {
  name: 'dsh-light',
  label: 'DeepSeek Light',
  isDark: false,
  preview: { canvas: '#f7f7f8', surface: '#ffffff', accentFrom: '#3b6ad6', accentTo: '#7c3aed' },
  naiveTheme: null,
  naiveOverrides: {
    common: {
      primaryColor: '#3b6ad6',
      primaryColorHover: '#2e59d2',
      primaryColorPressed: '#3b6ad6',
      bodyColor: '#ffffff',
      cardColor: '#f5f6f7',
      modalColor: '#ffffff',
      popoverColor: '#ffffff',
      borderColor: '#e3e5e9',
      inputColor: '#ffffff',
      actionColor: '#f5f6f7',
      tableColor: '#ffffff',
      hoverColor: 'rgba(59, 106, 214, 0.08)',
      // 占位符与辅助文字同源（P-20261019-4），双底 ≥4.5
      placeholderColor: '#646b76',
    },
  } as GlobalThemeOverrides,
  monacoBase: 'vs',
  monacoColors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0f1115',
    'editorLineNumber.foreground': '#9ca3af',
    'editorLineNumber.activeForeground': '#0f1115',
    'editor.lineHighlightBackground': '#f2f3f5',
    'editor.selectionBackground': '#c7d3fe',
    'editorCursor.foreground': '#4176e6',
    // diff 高亮颜色
    'diffEditor.insertedTextBackground': '#16a34a20',
    'diffEditor.removedTextBackground': '#dc262620',
    'diffEditor.insertedLineBackground': '#16a34a15',
    'diffEditor.removedLineBackground': '#dc262615',
    'diffEditor.diagonalFill': '#e3e5e9',
  },
  monacoRules: [
    { token: '', foreground: '17181c' },
    { token: 'comment', foreground: '9ca3af', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'dc2626' },
    { token: 'string', foreground: '0e7490' },
    { token: 'string.escape', foreground: '4d6bfe' },
    { token: 'number', foreground: '4d6bfe' },
    { token: 'type', foreground: '7c3aed' },
    { token: 'type.identifier', foreground: '7c3aed' },
    { token: 'function', foreground: '2563eb' },
    { token: 'variable', foreground: 'b45309' },
    { token: 'variable.predefined', foreground: '4d6bfe' },
    { token: 'variable.other.constant', foreground: '0e7490' },
    { token: 'operator', foreground: 'dc2626' },
    { token: 'delimiter', foreground: '17181c' },
    { token: 'delimiter.bracket', foreground: '17181c' },
    { token: 'tag', foreground: '16a34a' },
    { token: 'attribute.name', foreground: 'b45309' },
    { token: 'attribute.value', foreground: '0e7490' },
    { token: 'metatag', foreground: 'dc2626' },
    { token: 'regexp', foreground: '4d6bfe' },
    { token: 'constant', foreground: '4d6bfe' },
    { token: 'constant.language', foreground: '4d6bfe' },
    { token: 'namespace', foreground: '7c3aed' },
    { token: 'identifier', foreground: '17181c' },
  ],
  colors: {
    'bg-primary': '#ffffff',
    'bg-panel': '#f5f6f7',
    'bg-border': '#e3e5e9',
    'bg-hover': '#eceef1',
    'bg-active': '#e6edfd',
    'bg-search': '#4176e622',
    'bg-selection': '#c7d3fe',
    'bg-terminal': '#f5f6f7',
    'bg-warning': '#fef9c3',
    'bg-warning-alt': '#fef08a',
    'text-primary': '#0f1115',
    'text-body': '#20232a',
    'text-hover': '#0f1115',
    'text-secondary': '#5c616b',
    // 辅助文字档（P-20261019-4）：原 muted/dim 在双底仅 3.20/2.96，
    // 调到 #646b76 后 5.38/4.97（聚焦输入框 accent 叠层 4.71）；label 微调
    // 到 #656c76（4.90），dim #666d78（4.82）保持最弱档
    'text-muted': '#646b76',
    'text-dim': '#666d78',
    'text-label': '#656c76',
    // 链接正文 12~13px：原 #4176e6 在面板底仅 3.91，压到 #3567cf（4.86/5.26）
    'text-link': '#3567cf',
    'text-link-hover': '#2e59d2',
    'text-on-accent': '#ffffff',
    'border-default': '#e3e5e9',
    'border-subtle': '#eef0f2',
    'accent-blue': '#3b6ad6',
    'accent-blue-light': '#6f93f0',
    'accent-blue-hover': '#2e59d2',
    'accent-vs-blue': '#2563eb',
    'accent-green': '#15803d',
    'accent-green-dim': '#15803d99',
    'accent-red': '#dc2626',
    'accent-red-bright': '#b91c1c',
    'accent-yellow': '#ca8a04',
    'accent-orange': '#ea580c',
    // 等待档图形点（P-20261019-4）：原 #ca8a04 在 bg-panel 仅 2.71 < 3:1，
    // 压深到 #9a6700（4.50/4.87，保留黄色语义）
    'accent-yellow-warm': '#9a6700',
    // 等待档底色压深到 #9a6700 后，暖档墨色改用白（4.87；深墨仅 3.25）
    'on-accent-warm': '#ffffff',
    // 状态徽标语义色四档（P-20261003-285）：状态徽标族一律引用语义名而非直引
    // 色相 accent——「进行中/成功/失败/等待」→ 主题变量的映射表，同语义跨面
    // 同色由本表单一来源保证；主题气质微调只改这里的指向，不动组件面
    'status-running': 'var(--accent-blue)',
    'status-success': 'var(--accent-green)',
    'status-failed': 'var(--accent-red)',
    'status-waiting': 'var(--accent-yellow-warm)',
    // diff 色板两档四键（P-20261006-5，themes/diffPalette.ts 单点解析）：标准档
    // 红绿（与 accent-green/accent-red-bright 现值同相，hex 独立成键——diff 语义
    // 不混用全局成功/失败色防涟漪）；色弱档蓝/橙（deuteranopia-safe，与
    // accent-blue/accent-orange 同相）。hex 字面量是 Monaco 派生（叠 alpha）前提
    'diff-added': '#16a34a',
    'diff-removed': '#b91c1c',
    'diff-added-cb': '#4176e6',
    'diff-removed-cb': '#ea580c',
    'accent-purple': '#7c3aed',
    'accent-teal': '#0e7490',
    'dir-icon-color': '#6b7280',
    'focus-ring': '#4176e6',
    'graph-1': '#dc2626',
    'graph-2': '#4176e6',
    'graph-3': '#16a34a',
    'graph-4': '#7c3aed',
    'graph-5': '#ca8a04',
    'graph-6': '#0e7490',
    'instance-local': '#4176e6',
    'instance-online': '#16a34a',
    'instance-offline': '#9ca3af',
    'instance-unknown': '#ca8a04',
    // 表面分层（4 档深度）
    'bg-canvas': '#f7f7f8',
    'bg-surface': '#ffffff',
    'bg-elevated': '#ffffff',
    'bg-overlay': '#ffffff',
    'bg-glass': 'rgba(255, 255, 255, 0.85)',
    'overlay-mask': 'rgba(23, 24, 28, 0.35)',
    'rail-bg': '#f2f3f5',
    'statusbar-bg': '#f2f3f5',
    // 终端 / 编辑器 scrollbar
    'scrollbar-thumb': '#d8dade',
    'scrollbar-thumb-hover': '#b9bdc4',
    'scrollbar-track': 'transparent',
    // 品牌识别（渐变 + 锚点）
    'brand-accent': '#3b6ad6',
    'brand-accent-hover': '#2e59d2',
    'brand-accent-soft': 'rgba(59, 106, 214, 0.10)',
    'brand-amber': '#ea580c',
    'brand-gradient': 'linear-gradient(135deg, #4176e6 0%, #6f93f0 50%, #7c3aed 100%)',
    'brand-gradient-soft': 'linear-gradient(135deg, rgba(77,107,254,0.10) 0%, rgba(124,145,255,0.06) 50%, rgba(124,58,237,0.10) 100%)',
    // 边框层级
    'border-strong': '#c9cdd4',
    'border-brand': 'rgba(77, 107, 254, 0.45)',
    // 阴影系统
    'shadow-soft': '0 1px 0 rgba(255,255,255,0.6), 0 4px 12px rgba(23,24,28,0.10)',
    'shadow-strong': '0 1px 0 rgba(255,255,255,0.8), 0 12px 32px rgba(23,24,28,0.18)',
    'shadow-glow': '0 0 0 1px rgba(77,107,254,0.35), 0 0 18px rgba(77,107,254,0.22)',
    // 骨架屏
    'skeleton-base': 'rgba(23,24,28,0.08)',
    'skeleton-shine': 'rgba(23,24,28,0.14)',

    // Console 错误类别色（亮色主题：深前景 + 浅背景）
    'error-cat-network-fg':    '#4176e6',
    'error-cat-network-bg':    '#e6edfd',
    'error-cat-auth-fg':       '#ea580c',
    'error-cat-auth-bg':       '#fff1e6',
    'error-cat-forbidden-fg':  '#ea580c',
    'error-cat-forbidden-bg':  '#fff1e6',
    'error-cat-notFound-fg':   '#5c616b',
    'error-cat-notFound-bg':   '#eceef1',
    'error-cat-validation-fg': '#ca8a04',
    'error-cat-validation-bg': '#fef9c3',
    'error-cat-gitConflict-fg':'#dc2626',
    'error-cat-gitConflict-bg':'#fee2e2',
    'error-cat-conflict-fg':   '#dc2626',
    'error-cat-conflict-bg':   '#fee2e2',
    'error-cat-server-fg':     '#dc2626',
    'error-cat-server-bg':     '#fee2e2',
    'error-cat-client-fg':     '#ca8a04',
    'error-cat-client-bg':     '#fef9c3',
    'error-cat-unknown-fg':    '#5c616b',
    'error-cat-unknown-bg':    '#eceef1',

    // Console UI 通用
    'console-tab-bg':          '#eceef1',
    'console-tab-active-fg':   '#20232a',
    'console-tab-active-bg':   '#dde0e5',
    'console-row-divider':     '#e3e5e9',
    'console-row-hover-bg':    '#f7f7f8',
    'console-raw-bg':          '#fee2e2',
    'console-raw-border':      '#dc2626',
    'console-badge-bg':        '#dc2626',
    'console-badge-fg':        '#ffffff',

    // 全局锁定页语义色
    'lock-overlay-bg':  'rgba(247, 247, 248, 0.85)',
    'lock-card-bg':     'rgba(255, 255, 255, 0.95)',
    'lock-card-border': 'rgba(0, 0, 0, 0.08)',
    'lock-input-bg':    'rgba(244, 245, 247, 0.8)',
    'lock-input-border':'rgba(0, 0, 0, 0.12)',
    'lock-input-focus': 'var(--accent-blue)',
    'lock-error-color': '#dc2626',
    'lock-logo-color':  'var(--accent-blue)',
  },
}

import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon as WebGLAddon } from '@xterm/addon-webgl'
import { ImageAddon } from '@xterm/addon-image'
import { registerTerminalFileLinks } from './useTerminalFileLinks'
import type { TerminalCursorStyle } from '../stores/font'

// WebGL 上下文丢失处置工厂（模块级纯逻辑，测试直接覆盖）：浏览器对活跃 WebGL
// 上下文有 ~16 个上限，重度使用（agent 终端 + 项目终端 + docked 形态并存）超限后
// 最老上下文被驱逐——被驱逐终端渲染静默变空白/花屏且不可恢复。处置 = dispose
// WebGL addon 降级为 DOM renderer（官方支持路径，功能完好、大流量输出性能略降）
// + 每会话一次性 toast，把硬故障转化为透明损耗。首次触发后整体短路：dispose 幂等
// 已无须重做，提示只发一次防刷屏。返回值即 WebglAddon.onContextLoss 的回调
export interface WebglContextLossActions {
  // 释放 WebGL addon（xterm 自动回退 DOM renderer）
  dispose: () => void
  // 用户提示（toast 文案由调用方 i18n 组装）
  notify: () => void
}

export function createWebglContextLossHandler(actions: WebglContextLossActions): () => void {
  let handled = false
  return () => {
    if (handled) return
    handled = true
    actions.dispose()
    actions.notify()
  }
}

export interface CreateTerminalWithAddonsOptions {
  // 会话标识：文件路径链接层按会话解析项目上下文
  sessionId: string
  // 字号 / scrollback 行数 / 字体栈 / 主题色（连接时读取最新值）
  fontSize: number
  scrollback: number
  fontStack: string
  themeColors: ITheme
  // 光标形态/闪烁偏好（P-20261005-212，font store 设备本地）：连接时读取最新值。
  // 运行中会话的变更由 useTerminalInstances / TerminalPane 的 watch 直写
  // term.options 即时生效，此处只定创建期初值
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  // WebGL 上下文丢失的用户提示（toast 文案由调用方 i18n 组装，每会话一次性）
  onWebglContextLossNotify: () => void
}

export interface TerminalWithAddons {
  term: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
}

// 创建终端实例并装配全部 addon（自 useTerminalSession.connect 原样搬运）：
// fit / web-links / image / unicode11 / webgl(含上下文丢失降级)
// / search / 文件路径链接层。宿主拿到实例后负责 open 容器与 WS 生命周期
// （OSC 52 剪贴板 handler 亦由宿主连接期挂载，见 terminalOsc52Clipboard）。
export function createTerminalWithAddons(opts: CreateTerminalWithAddonsOptions): TerminalWithAddons {
  const term = new Terminal({
    fontSize: opts.fontSize,
    // 设置页「终端字体」的唯一生效路径（store 内置回退栈）
    fontFamily: opts.fontStack,
    theme: opts.themeColors,
    // 光标偏好（P-20261005-212）：设置页直写 font store 后 watch 即时生效，
    // 缺省 block+闪烁与原硬编码 cursorBlink: true 同值（存量行为零迁移）
    cursorStyle: opts.cursorStyle,
    cursorBlink: opts.cursorBlink,
    scrollback: opts.scrollback,
    allowProposedApi: true,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new WebLinksAddon())

  // OSC 52 剪贴板写入不在此装配（P-20261107-6，原 @xterm/addon-clipboard 让位
  // 并卸载依赖）：ClipboardAddon 写路径无成功/失败回调、且非安全上下文下静默
  // 哑写——改由宿主连接期挂 terminalOsc52Clipboard 的独占 handler（copyText
  // 降级链 + 能力已证信号 + 重放门禁短路，需 oscSink 门禁读数故不在本工厂）。
  // 同一 term 勿再装第二个 OSC 52 handler（独占消费约定，双挂即双写）。
  // 前端 Ctrl+Shift+C/V 与右键粘贴走 useTerminalClipboard 自实现路径（不变）

  // ImageAddon：iTerm2 IIP / Sixel / Kitty Graphics 三种图片协议
  // 让 imgcat / chafa / timg 等工具输出的图片直接在终端内显示
  // tmux 后端的 allow-passthrough on（已在 ensureTmuxConf 开启）保证序列透传
  try {
    term.loadAddon(new ImageAddon())
  } catch (err) {
    console.warn('image addon load failed', err)
  }

  // Unicode 11：宽字符（中文/emoji）宽度计算更准确，避免光标错位
  try {
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
  } catch (err) {
    console.warn('unicode11 addon load failed', err)
  }

  // WebGL renderer：大流量输出（cat 大文件 / tail -f）性能显著优于默认 DOM renderer。
  // 自动化环境（Playwright headless / 软件 WebGL）下 loadAddon 不抛错但 canvas 实际
  // 不渲染，因此以 navigator.webdriver 识别自动化环境——真实用户默认启用 WebGL，
  // 自动化测试保持可靠的 DOM renderer。
  // 上下文丢失处置（onContextLoss 须在 loadAddon 前注册，官方推荐路径）：上下文被
  // 浏览器驱逐（活跃上限 ~16 个）时 dispose addon 降级 DOM renderer + 一次性 toast
  if (navigator.webdriver !== true) {
    try {
      const webgl = new WebGLAddon()
      webgl.onContextLoss(
        createWebglContextLossHandler({
          dispose: () => webgl.dispose(),
          notify: opts.onWebglContextLossNotify,
        }),
      )
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('webgl renderer unavailable, fallback to dom renderer', err)
    }
  }

  // Search：Ctrl+F 唤起搜索框
  const searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)

  // 文件路径链接层：终端输出中的文件路径（含 :line:col 后缀）hover 可点、点击
  // 经 window 事件桥接 Layout 打开编辑器。与 WebLinksAddon 共存（匹配正则对
  // 协议地址不命中，http 链接仍归 addon）；会话/项目上下文在 provideLinks 时
  // 惰性解析——会话目录不属于任何已注册项目则整层静默（提供不了链接）
  registerTerminalFileLinks(term, opts.sessionId)

  return { term, fitAddon, searchAddon }
}

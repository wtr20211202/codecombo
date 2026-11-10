import { ref } from 'vue'
import { settingsApi } from '../api/domains/system'

// ============== tmux 鼠标接管开关（P-20261109-7 C） ==============
// 服务端全局语义（server settings 终态，非各组件本地态）：开=tmux mouse on
// （拖选进 tmux copy-mode 选择，MouseDragEnd copy-pipe 经 set-clipboard 进系统
// 剪贴板；claude 滚轮翻页/tmux 分屏能力保留，业界主流默认）；关=「复制优先
// 模式」（tmux mouse off，拖选落回 xterm 原生选择+copyOnSelect；代价：tmux 处
// alt screen 时滚轮翻史失效、分屏拖拽/点击切 pane 失效——文案如实呈现）。
//
// 服务端 ApplyTmuxMouseOption 热切换（mouse 逐事件读取）：PUT 成功后现存全部
// 专有 socket（-L codecombo）会话即刻生效，无需重挂/重启。本模块只承载前端
// 反应式镜像与写路径收口（单一写点，P-20261007-1 惯例）——设置页开关行与
// Shift 教育条「切换到复制优先」一键按钮共用。只覆盖本地终端（专有 socket）；
// 远程终端的远端 tmux 是用户自有默认 socket server，行为不托管（设置项文案
// 与 CLAUDE.md 同口径声明）。

export const DEFAULT_TMUX_MOUSE_ENABLED = true

// 模块级反应式镜像：设置页 load 同步初值（syncTmuxMouseTakeoverLocal），写
// 路径乐观翻转、失败回滚——提示条按钮与设置页开关天然同帧一致
const enabled = ref(DEFAULT_TMUX_MOUSE_ENABLED)

/** 当前「tmux 鼠标接管」开关值（反应式；提示条按钮显隐/文案读取可追踪） */
export function isTmuxMouseTakeoverEnabled(): boolean {
  return enabled.value
}

/** 设置页 load 后同步初值（undefined/缺字段=服务端未配置，保持缺省开） */
export function syncTmuxMouseTakeoverLocal(v: boolean | undefined): void {
  if (typeof v === 'boolean') enabled.value = v
}

/**
 * 写「tmux 鼠标接管」开关（收口单一写点）：乐观更新 + 服务端 PUT（silent——
 * 教育条一键与设置页直写行都不走全局错误弹层，失败由调用方 toast），
 * 失败回滚本地值（失败可恢复红线）。服务端落盘成功即 ApplyTmuxMouseOption
 * 热切换，现存会话逐事件读取即刻生效。
 * 返回 true=已生效；false=服务端拒绝（本地已回滚，调用方给出可行动提示）
 */
export async function setTmuxMouseTakeover(v: boolean): Promise<boolean> {
  const prev = enabled.value
  enabled.value = v
  try {
    await settingsApi.update({ terminalTmuxMouseEnabled: v }, { silent: true })
    return true
  } catch {
    enabled.value = prev
    return false
  }
}

import type { Instance } from '../../stores/instance'
import i18n from '../../i18n'

// 实例展示辅助：指示器首字母 / 状态点颜色 / 副行 host

export function getInstanceInitial(inst: Instance): string {
  if (inst.isLocal) {
    const local = i18n.global.t('instance.local')
    return local.slice(0, 1).toUpperCase()
  }
  return inst.name.slice(0, 1).toUpperCase()
}

// 展示名：本机显示本地化文案，远程显示名称
export function getInstanceDisplayName(inst: Instance): string {
  return inst.isLocal ? i18n.global.t('instance.local') : inst.name
}

// 状态点颜色：本机蓝 / 在线绿 / 离线灰 / 未知黄 / 非本应用红（CSS 变量四主题齐全）
export function getInstanceDotColor(inst: Instance): string {
  if (inst.isLocal) return 'var(--instance-local)'
  if (inst.status === 'online') return 'var(--instance-online)'
  if (inst.status === 'offline') return 'var(--instance-offline)'
  if (inst.status === 'invalid') return 'var(--accent-red)'
  return 'var(--instance-unknown)'
}

// 副行展示的 host:port——远程实例去掉协议前缀，本机用当前页面地址
export function getInstanceHost(inst: Instance): string {
  if (inst.isLocal) return window.location.host
  try {
    return new URL(inst.url).host
  } catch {
    return inst.url
  }
}

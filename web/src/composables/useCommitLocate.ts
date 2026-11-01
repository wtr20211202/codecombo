import { ref } from 'vue'
import { usePanelLayout } from './usePanelLayout'

/**
 * 提交定位意图（模块级单例）：blame 注入文本点击提交 id → 底部 Git 面板
 * 滚动选中对应提交。
 * 跨组件时序由「请求方开面板 + 面板方消费」分担：CommitsPanel 随 bottomTab
 * 惰性挂载，请求发出时可能尚未挂载——pendingHash 是模块级 ref，挂载方
 * onMounted 与 watch 双通道消费，事件不丢；路由切换不刷新页面，状态天然共享
 */

/** 归一化 8 位 hash 片段（blame 注入文本携带的即 8 位短 hash） */
export function normalizeCommitFragment(hash: string): string {
  return (hash || '').trim().slice(0, 8).toLowerCase()
}

const pendingHash = ref('')

export function useCommitLocate() {
  /** 请求定位：记录片段并确保底部 Git 面板可见（CommitsPanel 挂载后消费） */
  function requestCommitLocate(hashFragment: string) {
    const frag = normalizeCommitFragment(hashFragment)
    if (!frag) return
    pendingHash.value = frag
    const layout = usePanelLayout()
    layout.showBottomPanel.value = true
    layout.bottomTab.value = 'git'
  }

  function consumeCommitLocate(): string {
    const h = pendingHash.value
    pendingHash.value = ''
    return h
  }

  return { pendingHash, requestCommitLocate, consumeCommitLocate }
}

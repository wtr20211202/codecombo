// 用户偏好写路径脏标记总线（P-20261007-1 Settings Sync）：各偏好 store 的写
// 路径（keymap persist / dnd·sound·simple set / terminal-theme setFollowAppTheme /
// copyOnSelect setter）只发「有偏好变了」的通知，服务端漫游的合并与 PUT 编排
// 全在 stores/userPrefs.ts——本模块是零依赖叶子，避免偏好 store ↔ 编排 store
// 的 import 环（编排 store 要 import 各偏好 store 做远端值应用）。
//
// 单订阅者即够（编排器全局一份）；未订阅时通知是 no-op（启动早期写偏好的
// 场景静默丢弃，首次 pull 的播种分支会补齐上云）。

type DirtyListener = () => void

let listener: DirtyListener | null = null

/** 偏好 store 写路径调用：通知编排器「本地偏好有变，待上云」 */
export function notifyUserPrefsDirty(): void {
  listener?.()
}

/** 编排器订阅脏标记，返回退订函数（生产在 userPrefs store 首次激活时装上） */
export function onUserPrefsDirty(fn: DirtyListener): () => void {
  listener = fn
  return () => {
    if (listener === fn) listener = null
  }
}

import { ref } from 'vue'

/**
 * scope=view 重载的 remount tick（P-20261111-3 frontend.reload 原语）：消费链
 * （utils/frontendAtomActions）bump，App.vue 的 RouterView :key 绑定——翻转
 * 即当前路由整树 remount：组件作用域状态销毁重初始化、各视图 onMounted 数据
 * 链重跑，路由与 URL 零变化。语义与「navigate 到别处再跳回」的挂载生命周期
 * 同构而零路由副作用（提案动机：配置推送/批量写后要求前端重取全量状态，
 * 替代两跳 navigate 绕行）。
 *
 * 与实例切换同机制（App.vue 既有 :key="instanceStore.currentInstanceId" 的
 * 生产先例）：未保存编辑由 IndexedDB 草稿自动保存（2s 防抖，P-129）与引导
 * 恢复链兜底，remount 不丢数据。模块级 ref 而非 store：单一消费对（bump 方
 * + 读方 App.vue），无跨组件共享面，不值得入 pinia。
 */
const viewReloadTick = ref(0)

/** Remount tick（只读视图：App.vue :key 绑定；写路径只有 bumpViewReload） */
export function useViewReloadTick() {
  return viewReloadTick
}

/** 触发当前路由整树 remount（frontend.reload scope=view 消费链唯一调用方） */
export function bumpViewReload(): void {
  viewReloadTick.value++
}

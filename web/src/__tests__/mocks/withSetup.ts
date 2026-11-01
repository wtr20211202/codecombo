import { createApp, h, type App } from 'vue'

/**
 * composable 流程测试的 setup 上下文（P-20261007-5 与 naiveRuntime 工厂配套）。
 *
 * 为什么需要：直接裸调 useXxx() 时不在组件 setup 期，`inject()` 拿不到 app 级
 * provide、只回落默认值之外的 undefined——useCommitActions 的共享 aheadBehind
 * 地图 / pushNotification 这类 inject 面必须真组件上下文才能测「连招全链」。
 * 本仓组件测试用 @vue/test-utils 的 mount，composable 场景挂一个空渲染组件更轻。
 *
 * 用法（在 setActivePinia 之后调）：
 *   const { result, app } = withSetup(() => useCommitActions(opts), {
 *     sharedAheadBehindMap: ref({ p1: { ahead: 0, behind: 2 } }),
 *     pushNotification: pushMock,
 *   })
 *   // ...断言 result 上的状态与函数
 *   app.unmount() // 关心 watch/onScopeDispose 清理时显式调，不调也不影响断言
 */
export function withSetup<T>(
  composable: () => T,
  provide?: Record<PropertyKey, unknown>,
): { result: T; app: App<Element> } {
  let result!: T
  const app = createApp({
    setup() {
      result = composable()
      // 空渲染：本 harness 只为 setup 上下文，不出 DOM
      return () => h('div')
    },
  })
  for (const [key, value] of Object.entries(provide ?? {})) {
    app.provide(key, value)
  }
  app.mount(document.createElement('div'))
  return { result, app }
}

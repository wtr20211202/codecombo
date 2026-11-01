import type { Page } from '@playwright/test'

// 桌面通知桩（notify-dnd-error-pierce.spec 使用）：音频/系统弹层不可 e2e 断言
//（headless 语境无系统通知输出，e2e 页面恒可见态下 useDesktopNotify 的
// document.hidden 门本就跳过弹出——notify-dnd.spec 注记同款限制），以记录型
// Notification 构造器桩把「桌面通知是否发出」暴露为 window.__desktopNotifyCalls
// 供断言。门控矩阵（免打扰/锁定/精简/权限）由 useDesktopNotify 单测覆盖，
// 桩只回答「真实应用通知链路是否发出桌面通知」。

// 注入桩三件事（addInitScript：先于应用代码执行）：
//   1. window.Notification → 记录型构造器（permission 预置 granted——桩的职责
//      是调用记录，权限请求链路属浏览器交互不经此覆盖）
//   2. document.hidden → 恒 true（补齐可见性门的前置；应用监听 visibilitychange
//      事件，静态覆写不触发事件，无其他行为面波及）
//   3. window.__desktopNotifyInstances → 实例登记（P-20261004-121 点击直达链
//      断言入口：真实浏览器无系统弹层可点，clickDesktopNotification 转发 onclick）
export async function installDesktopNotifyStub(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __desktopNotifyCalls?: Array<{ title: string; body?: string; data?: unknown }>
      __desktopNotifyInstances?: Array<{ onclick?: (e?: Event) => void }>
    }
    w.__desktopNotifyCalls = []
    w.__desktopNotifyInstances = []
    class FakeNotification {
      static permission = 'granted'
      constructor(title: string, opts?: { body?: string; data?: unknown }) {
        // data 仅在通知携带时落档（P-20261004-121 会话直达落点；无归属为
        // undefined，toEqual 语义下与旧形状 {title, body} 等价，既有断言不受扰）
        w.__desktopNotifyCalls!.push({ title, body: opts?.body, data: opts?.data })
        w.__desktopNotifyInstances!.push(this)
      }
      close() { /* noop：真实实现的 5s 自动关闭在桩上无意义 */ }
    }
    Object.defineProperty(window, 'Notification', {
      value: FakeNotification, configurable: true, writable: true,
    })
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  })
}

/** 已发出的桌面通知调用记录（title+body+data；未发出为空数组） */
export function desktopNotifyCalls(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __desktopNotifyCalls?: Array<{ title: string; body?: string; data?: unknown }> })
      .__desktopNotifyCalls ?? []
  )
}

/** 点击第 index（默认首条）个已发出的桌面通知：桩实例转发 onclick——真实
 * 浏览器侧系统弹层不可编程点击，点击直达链（P-20261004-121）由本入口触发后
 * 断言派发的 OPS_ACTIVATE_TERMINAL 广播与窗口聚焦 */
export async function clickDesktopNotification(page: Page, index = 0) {
  await page.evaluate((i) => {
    const n = (window as unknown as { __desktopNotifyInstances?: Array<{ onclick?: (e?: Event) => void }> })
      .__desktopNotifyInstances?.[i]
    n?.onclick?.(new Event('click'))
  }, index)
}

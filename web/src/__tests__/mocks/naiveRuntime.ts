import { ref } from 'vue'
import { vi } from 'vitest'

/**
 * composable 单测的一站式 naive-ui / vue-i18n 运行时 mock 工厂（P-20261007-5）。
 *
 * 动机：CLAUDE.md 测试纪律「依赖 useI18n()/createDiscreteApi() 的 composable 无法
 * 在 jsdom 中测试，改用 mock」长期只有路径没有基建——每个测试文件手抄 20~30 行
 * vi.hoisted + vi.mock 工厂（useEditorAskAgent/useTodoAgentFix/useBranchCheckout
 * 等 14+ 文件各持一份近同拷贝），成本高到纯逻辑件普遍弃测改走 e2e。
 *
 * 用法（测试文件顶部）：
 *   import { messageMock, dialogMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'
 *   vi.mock('naive-ui', async (importOriginal) =>
 *     (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()))
 *   vi.mock('vue-i18n', async (importOriginal) =>
 *     (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()))
 *
 * 形态定夺（提案要求双形态评估后注记）：
 * - 选 **vi.mock 工厂委托**而非 `__mocks__/` 目录：naive-ui 必须部分 mock
 *   （NButton/darkTheme 等真值被 useBranchCheckout 三选按钮区与主题 store 消费），
 *   node_modules 包的 __mocks__ 是整包替换、拿不到 importOriginal，会把整条
 *   naive-ui 依赖面拖进桩内重造——工厂形态四行换真值合并，零重造。
 * - 不做「helper 内部代调 vi.mock」的一行 side-effect import：vi.mock 不经测试文件
 *   hoist，生效与否取决于 import 书写顺序（helper 必须先于被测模块求值），静默
 *   失败面大；委托两行是 hoist 保证的零时序敏感写法。
 *
 * 断言语义（提案②分层）：断言按 **key** 不按文案——t 为 key 直通（插值参数以
 * JSON 后缀保留可断言），键名即行为契约；键→双语值的同构由 locale parity 测试守，
 * 两层各守一面。message/dialog 不再是裸 no-op：全部方法收敛到 messageMock/dialogMock
 * 记录器，可直接 toHaveBeenCalledWith 断言「该路径发过什么级提示」。
 */

/** key 直通 t：无参返回 key 本体；带参返回 `key:{"p":...}`（插值发生且参数可断言）。
 *  形状与 useBranchCheckout 既有单测的断言字面完全一致（迁移零断言改动）。 */
export function tKey(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

/** naive-ui message 记录器：composable 里 useMessage() 拿到的就是它。
 *  方法本身是 vi.fn——断言 messageMock.success/warning/error 即断言提示路径。 */
export const messageMock = {
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
}

/** DialogReactive 最小契约：naive-ui 的 dialog 方法返回带 destroy 的句柄，
 *  useBranchCheckout 等的三选按钮 onClick 里会调 d.destroy()——桩必须同形。 */
interface MockDialogReactive {
  destroy: ReturnType<typeof vi.fn>
}

function makeDialogMethod(): ReturnType<typeof vi.fn> {
  const fn = vi.fn((): MockDialogReactive => ({ destroy: vi.fn() }))
  return fn
}

/** naive-ui dialog 记录器：useDialog() 拿到的就是它（warning/info/error/success/
 *  create 全收敛，返回值恒为 { destroy } 句柄；句柄从 mock.results 取）。 */
export const dialogMock = {
  success: makeDialogMethod(),
  warning: makeDialogMethod(),
  info: makeDialogMethod(),
  error: makeDialogMethod(),
  create: makeDialogMethod(),
}

/** createDiscreteApi 桩（useAgentFix 等离散面）：message/dialog 就是上面的记录器
 *  ——离散提示与注入式提示断言同源（P-20261003-273 前此桩 dialog 只有 create，
 *  discrete 面调 warning 等即 TypeError，收进同记录器补齐该缺口）；
 *  notification 记录为裸 vi.fn 够用。 */
export const discreteApiMock = vi.fn(() => ({
  message: messageMock,
  dialog: dialogMock,
  notification: { create: vi.fn() },
}))

/** vue-i18n partial mock：只换 useI18n（t=key 直通 + locale ref），其余导出
 *  （createI18n 等被间接依赖面）保持真值。 */
export function mockVueI18n(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    useI18n: () => ({ t: tKey, locale: ref('zh-CN') }),
  }
}

/** naive-ui partial mock：换 useMessage/useDialog/createDiscreteApi 三口，
 *  其余（NButton/darkTheme/createDiscreteApi 之外的组件与主题包）保持真值。 */
export function mockNaiveUi(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    useMessage: () => messageMock,
    useDialog: () => dialogMock,
    createDiscreteApi: discreteApiMock,
  }
}

/** 复位记录器（beforeEach 调）：清调用历史并还原 dialog 返回值契约（mockReset
 *  会连 implementation 一起清，必须重新接线）。 */
export function resetNaiveRuntimeMocks(): void {
  discreteApiMock.mockClear()
  for (const fn of Object.values(messageMock)) fn.mockClear()
  for (const fn of Object.values(dialogMock)) {
    fn.mockReset()
    fn.mockImplementation(() => ({ destroy: vi.fn() }))
  }
}

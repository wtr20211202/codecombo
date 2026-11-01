import { mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import {
  approvalHotkeyDecision,
  isEditableTarget,
  useApprovalHotkeys,
  type ApprovalHotkeyActions,
} from '@/composables/useApprovalHotkeys'
import { useApprovalsStore } from '@/stores/approvals'
import type { ApprovalRecord } from '@/api/domains/opsconfirm'

/**
 * 审批卡键盘裁决（P-20261003-1）单测：守卫判定（可编辑面/组合键/IME/前置
 * 消费/弹层在场/无待裁决卡）+ 键位映射（1=允许一次 / 2=完全允许二次确认
 * 入口 / 3=拒绝）+ 目标卡（首张）+ 卸载解绑。
 * 宿主组件挂载触发 onMounted 注册 document 监听，真实 keydown 事件派发验证。
 */

function rec(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return { id: 'op-1', op: 'write_file', status: 'pending', ...overrides }
}

function makeActions() {
  return {
    allowOnce: vi.fn(),
    requestAllowAlways: vi.fn(),
    deny: vi.fn(),
  } satisfies ApprovalHotkeyActions
}

/** 宿主组件：setup 内挂全局监听（onMounted 需组件实例） */
function mountHost(actions: ApprovalHotkeyActions): VueWrapper {
  const Host = defineComponent({
    setup() {
      useApprovalHotkeys(actions)
      return () => h('div')
    },
  })
  return mount(Host, { attachTo: document.body })
}

/** 真实 keydown 派发（默认 target=document.body，bubbles 到 document 监听器） */
function press(key: string, target: HTMLElement = document.body, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    ...init,
  })
  target.dispatchEvent(e)
  return e
}

describe('useApprovalHotkeys', () => {
  let actions: ReturnType<typeof makeActions>
  let wrapper: VueWrapper | null = null
  let consumer: ((e: Event) => void) | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    actions = makeActions()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    if (consumer) {
      document.removeEventListener('keydown', consumer)
      consumer = null
    }
    document.body.innerHTML = ''
  })

  /** 前置消费器（先于热键监听注册，模拟真实场景中 Layout 键盘先注册先执行） */
  function mountWithConsumer(actions: ApprovalHotkeyActions): void {
    consumer = (e: Event): void => e.preventDefault()
    document.addEventListener('keydown', consumer)
    wrapper = mountHost(actions)
  }

  it('无待裁决卡放行：不消费按键、不调任何动作', () => {
    wrapper = mountHost(actions)
    const e = press('1')
    expect(e.defaultPrevented).toBe(false)
    expect(actions.allowOnce).not.toHaveBeenCalled()
    expect(actions.requestAllowAlways).not.toHaveBeenCalled()
    expect(actions.deny).not.toHaveBeenCalled()
  })

  it('键映射：1=允许一次 / 2=完全允许（二次确认入口非直接落账）/ 3=拒绝', () => {
    const store = useApprovalsStore()
    wrapper = mountHost(actions)

    store.upsert(rec({ id: 'a' }))
    expect(press('1').defaultPrevented).toBe(true)
    expect(actions.allowOnce).toHaveBeenCalledTimes(1)
    expect(actions.allowOnce).toHaveBeenCalledWith('a')

    expect(press('2').defaultPrevented).toBe(true)
    expect(actions.requestAllowAlways).toHaveBeenCalledTimes(1)
    expect(actions.requestAllowAlways).toHaveBeenCalledWith('a')
    // 键 2 不直接落账（P-126 二次确认语义）
    expect(actions.allowOnce).toHaveBeenCalledTimes(1)

    expect(press('3').defaultPrevented).toBe(true)
    expect(actions.deny).toHaveBeenCalledTimes(1)
    expect(actions.deny).toHaveBeenCalledWith('a')
  })

  it('非 1/2/3 键放行（不消费）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    wrapper = mountHost(actions)
    for (const key of ['4', 'a', 'Enter', 'Escape']) {
      expect(press(key).defaultPrevented).toBe(false)
    }
    expect(actions.allowOnce).not.toHaveBeenCalled()
    expect(actions.deny).not.toHaveBeenCalled()
  })

  it('组合键放行：Ctrl/Meta/Alt/Shift 修饰的数字各有归宿，热键不接管', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    wrapper = mountHost(actions)
    expect(press('1', document.body, { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press('1', document.body, { metaKey: true }).defaultPrevented).toBe(false)
    expect(press('1', document.body, { altKey: true }).defaultPrevented).toBe(false)
    expect(press('1', document.body, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(actions.allowOnce).not.toHaveBeenCalled()
  })

  it('IME 合成中放行：候选输入的数字不触发裁决', () => {
    const store = useApprovalsStore()
    wrapper = mountHost(actions)
    store.upsert(rec({ id: 'a' }))

    expect(press('1', document.body, { isComposing: true }).defaultPrevented).toBe(false)
    expect(actions.allowOnce).not.toHaveBeenCalled()
    expect(press('1').defaultPrevented).toBe(true)
    expect(actions.allowOnce).toHaveBeenCalledTimes(1)
  })

  it('前置链已消费（defaultPrevented）放行：不重复接管', () => {
    const store = useApprovalsStore()
    mountWithConsumer(actions)
    store.upsert(rec({ id: 'a' }))

    expect(press('1').defaultPrevented).toBe(true)
    expect(actions.allowOnce).not.toHaveBeenCalled()
  })

  it('焦点在可编辑面放行：input / textarea（含 Monaco inputarea）/ contentEditable', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    wrapper = mountHost(actions)

    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const inputarea = document.createElement('textarea')
    inputarea.className = 'inputarea'
    for (const el of [input, textarea, inputarea]) document.body.appendChild(el)

    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(textarea)).toBe(true)
    expect(isEditableTarget(document.body)).toBe(false)
    // jsdom 未实现 isContentEditable（恒 undefined），contentEditable 路径以
    // 属性桩直接验证纯函数（浏览器真值语义）
    const editable = document.createElement('div')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isEditableTarget(editable)).toBe(true)

    for (const el of [input, textarea, inputarea]) {
      expect(press('1', el).defaultPrevented).toBe(false)
    }
    expect(actions.allowOnce).not.toHaveBeenCalled()

    // 失焦（回 body）后同键生效——守卫精确，不是热键失灵
    expect(press('1').defaultPrevented).toBe(true)
    expect(actions.allowOnce).toHaveBeenCalledTimes(1)
  })

  it('模态弹层在场放行（裁决卡被压在弹层下，不隔空生效）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    wrapper = mountHost(actions)

    const overlay = document.createElement('div')
    overlay.className = 'n-modal'
    document.body.appendChild(overlay)
    expect(press('1').defaultPrevented).toBe(false)
    expect(actions.allowOnce).not.toHaveBeenCalled()

    overlay.remove()
    expect(press('1').defaultPrevented).toBe(true)
    expect(actions.allowOnce).toHaveBeenCalledTimes(1)
  })

  it('多卡只裁首张：pendingList[0] 即屏上首卡，逐张清账', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    store.upsert(rec({ id: 'b' }))
    wrapper = mountHost(actions)

    expect(press('1').defaultPrevented).toBe(true)
    expect(actions.allowOnce).toHaveBeenCalledTimes(1)
    expect(actions.allowOnce).toHaveBeenCalledWith('a')

    expect(press('3').defaultPrevented).toBe(true)
    expect(actions.deny).toHaveBeenCalledTimes(1)
    expect(actions.deny).toHaveBeenCalledWith('a')
    expect(actions.allowOnce).not.toHaveBeenCalledWith('b')
    expect(actions.deny).not.toHaveBeenCalledWith('b')
  })

  it('卸载解绑：监听不残留，卸载后按键放行', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    wrapper = mountHost(actions)
    wrapper.unmount()
    wrapper = null
    const e = press('1')
    expect(e.defaultPrevented).toBe(false)
    expect(actions.allowOnce).not.toHaveBeenCalled()
  })

  it('approvalHotkeyDecision 纯函数：命中返回动作本身，未命中返回 null', () => {
    const acts = makeActions()
    const ev = (init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent =>
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    expect(approvalHotkeyDecision(ev({ key: '1' }), acts)).toBe(acts.allowOnce)
    expect(approvalHotkeyDecision(ev({ key: '2' }), acts)).toBe(acts.requestAllowAlways)
    expect(approvalHotkeyDecision(ev({ key: '3' }), acts)).toBe(acts.deny)
    expect(approvalHotkeyDecision(ev({ key: '9' }), acts)).toBeNull()
    expect(approvalHotkeyDecision(ev({ key: '1', ctrlKey: true }), acts)).toBeNull()
    expect(approvalHotkeyDecision(ev({ key: '1', isComposing: true }), acts)).toBeNull()
  })
})

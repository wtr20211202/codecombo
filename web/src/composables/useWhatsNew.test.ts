import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：safeStorage 走内存 Map（真身封装的兜底语义同款）、whatsNewApi
// 按 URL 形态桩定（成功/失败两路），isNewerVersion 用 utils/version 真身
//（semver 比较是 delta 判定的核心语义，不 mock）──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})
const getMock = vi.hoisted(() => vi.fn())

vi.mock('../utils/storage', () => ({ safeStorage: backing }))
vi.mock('../api/domains/system', () => ({
  whatsNewApi: { get: getMock },
}))

import {
  WHATS_NEW_SEEN_KEY,
  checkWhatsNew,
  dismissWhatsNew,
  markWhatsNewSeen,
  resetWhatsNewForTest,
  useWhatsNew,
  whatsNewDelta,
  whatsNewSeen,
} from './useWhatsNew'
import { nextTick } from 'vue'
import type { WhatsNewSection } from '../api/domains/system'

const SEC = (version: string, title = `t-${version}`): WhatsNewSection => ({ version, title, body: `- ${title}` })

/** 桩定端点响应并跑一次启动判定（checkWhatsNew 内部为 fire-and-forget 异步） */
async function checkWith(sections: WhatsNewSection[] | null): Promise<void> {
  resetWhatsNewForTest()
  getMock.mockResolvedValue({ data: sections === null ? {} : { version: '9.9.9', content: 'x', sections } })
  checkWhatsNew()
  await vi.waitFor(() => { expect(getMock).toHaveBeenCalled() })
  // 微任务排空：判定链的后续同步段已执行完
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  backing.clear()
  getMock.mockReset()
})

describe('whatsNewDelta 段落差集（P-20261007-17）', () => {
  it('只留严格新于已读版本的段落；无版本号段落不参与判定', () => {
    const sections = [SEC('0.0.3'), SEC('0.0.2'), { version: '', title: '无版本', body: 'x' }, SEC('0.0.1')]
    expect(whatsNewDelta(sections, '0.0.2')).toEqual([SEC('0.0.3')])
    expect(whatsNewDelta(sections, '0.0.0')).toHaveLength(3)
  })

  it('已读为 null（首启无记录）= 空 delta（不弹）', () => {
    expect(whatsNewDelta([SEC('0.0.1')], null)).toEqual([])
  })

  it('任一侧非 semver（dev 构建基线）视为不新——宁可漏弹不误弹', () => {
    expect(whatsNewDelta([SEC('0.0.2')], 'dev')).toEqual([])
  })
})

describe('markWhatsNewSeen 已读记账', () => {
  it('取展示段落中最新的版本号（不依赖段序）', () => {
    markWhatsNewSeen([SEC('0.0.2'), SEC('0.0.3'), SEC('0.0.1')])
    expect(backing.getItem(WHATS_NEW_SEEN_KEY)).toBe('0.0.3')
  })

  it('全部无版本号段落时保持原基线不动', () => {
    backing.setItem(WHATS_NEW_SEEN_KEY, '0.0.1')
    markWhatsNewSeen([{ version: '', title: 'x', body: '' }])
    expect(backing.getItem(WHATS_NEW_SEEN_KEY)).toBe('0.0.1')
  })
})

describe('checkWhatsNew 启动判定', () => {
  it('首启无已读记录：静默记当前最新段为已读，不弹', async () => {
    await checkWith([SEC('0.0.2'), SEC('0.0.1')])
    const { show } = useWhatsNew()
    expect(show.value).toBe(false)
    expect(whatsNewSeen()).toBe('0.0.2')
  })

  it('有升级差：亮弹层且 delta 只含新版段落', async () => {
    backing.setItem(WHATS_NEW_SEEN_KEY, '0.0.1')
    await checkWith([SEC('0.0.2'), SEC('0.0.1')])
    const { show, delta } = useWhatsNew()
    expect(show.value).toBe(true)
    expect(delta.value).toEqual([SEC('0.0.2')])
  })

  it('关闭即记已读：dismiss 后弹层消失，刷新级判定（重跑 check）不再弹', async () => {
    backing.setItem(WHATS_NEW_SEEN_KEY, '0.0.1')
    await checkWith([SEC('0.0.2'), SEC('0.0.1')])
    dismissWhatsNew()
    const { show } = useWhatsNew()
    expect(show.value).toBe(false)
    expect(whatsNewSeen()).toBe('0.0.2')

    await checkWith([SEC('0.0.2'), SEC('0.0.1')])
    expect(useWhatsNew().show.value).toBe(false)
  })

  it('遮罩/Esc 关闭路径：show 直接置 false 同样记账（不经 dismissWhatsNew）', async () => {
    backing.setItem(WHATS_NEW_SEEN_KEY, '0.0.1')
    await checkWith([SEC('0.0.2')])
    const { show } = useWhatsNew()
    expect(show.value).toBe(true)
    show.value = false
    await nextTick()
    expect(whatsNewSeen()).toBe('0.0.2')
  })

  it('端点失败 / 空段落：静默跳过（不弹也不写基线）', async () => {
    resetWhatsNewForTest()
    getMock.mockRejectedValue(new Error('404'))
    checkWhatsNew()
    await Promise.resolve()
    await Promise.resolve()
    expect(useWhatsNew().show.value).toBe(false)
    expect(whatsNewSeen()).toBeNull()

    await checkWith([])
    expect(whatsNewSeen()).toBeNull()
  })
})

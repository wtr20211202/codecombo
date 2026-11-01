import { describe, it, expect } from 'vitest'
import zhCN from '@/locales/zh-CN'
import enUS from '@/locales/en-US'

// zh/en 键位对齐守护：两边键树必须完全一致（此前曾以人工核对 1777=1777 的方式审计，
// 新增功能键只加一边就会静默漏译——这里固化为单测）

function collectKeys(obj: unknown, prefix = '', acc: string[] = []): string[] {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      collectKeys((obj as Record<string, unknown>)[k], path, acc)
    }
  } else {
    acc.push(prefix)
  }
  return acc
}

describe('i18n 键位对齐', () => {
  it('zh-CN 与 en-US 键树完全一致', () => {
    const zh = new Set(collectKeys(zhCN))
    const en = new Set(collectKeys(enUS))
    const onlyZh = [...zh].filter(k => !en.has(k))
    const onlyEn = [...en].filter(k => !zh.has(k))
    expect(onlyZh, 'zh-CN 独有键（en-US 缺失）').toEqual([])
    expect(onlyEn, 'en-US 独有键（zh-CN 缺失）').toEqual([])
    expect(zh.size).toBe(en.size)
  })

  it('近期新功能键双语言齐全（悬浮球/智能体选型）', () => {
    const required = [
      'agentTerminal.ballShapeBall', 'agentTerminal.ballShapeBar', 'agentTerminal.ballShapeList',
      'agentTerminal.ballSize_small', 'agentTerminal.ballSize_medium', 'agentTerminal.ballSize_large',
      'agentTerminal.ballOpacitySolid', 'agentTerminal.ballOpacityTranslucent',
      'settings.agentProvider', 'settings.agentProviderAuto', 'settings.agentProviderDesc',
    ]
    function has(root: unknown, path: string): boolean {
      let cur: unknown = root
      for (const seg of path.split('.')) {
        if (!cur || typeof cur !== 'object') return false
        cur = (cur as Record<string, unknown>)[seg]
      }
      return typeof cur === 'string' && cur.length > 0
    }
    for (const k of required) {
      expect(has(zhCN, k), `zh-CN 缺 ${k}`).toBe(true)
      expect(has(enUS, k), `en-US 缺 ${k}`).toBe(true)
    }
  })
})

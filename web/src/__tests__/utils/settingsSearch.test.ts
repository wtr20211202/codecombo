import { describe, it, expect } from 'vitest'
import zhCN from '@/locales/zh-CN'
import {
  SETTINGS_TAB_KEYS, SETTINGS_TAB_LABEL_KEYS, settingsKeywordKey,
  settingsAnchorWords, pinyinInitials, type SettingsTabKey,
} from '@/utils/settingsSearch'

/**
 * 设置搜索拼音首字母检索（P-20261003-220）单测：
 *   - pinyinInitials 基本语义（首字母串/词级多音字覆写/英文不产出/未收录降级）
 *   - 语料覆盖守卫：zh 分区语料（标题+关键词+锚点词，与 SettingsModal haystack
 *     同构）里每个含汉字的词都必须可索引——新增关键词引入未收录的字时本组即红
 *   - 定向查询唯一性守卫：e2e（settings-search.spec.ts）断言的查询→分区映射
 *     在这里先行对账，词条演进打破唯一性时先红单测而不是先红 e2e
 */

// 点路径取 zh 词条（'settingsTabs.general' / 'settings.securityTitle' / settingsSearch.keywords.*）
function zhText(path: string): string {
  let node: unknown = zhCN
  for (const seg of path.split('.')) node = (node as Record<string, unknown>)[seg]
  return node as string
}

// 与 SettingsModal.visibleTabs 的 haystack 组合同构：标题 + 关键词 + 锚点词
// （Modal 侧若改组合方式，此处须同步）
function tabCorpus(tab: SettingsTabKey): string {
  return `${zhText(SETTINGS_TAB_LABEL_KEYS[tab])} ${zhText(settingsKeywordKey(tab))} ${settingsAnchorWords(tab)}`
}

describe('pinyinInitials 基本语义', () => {
  it('汉字词 → 首字母串，词间以空格分隔', () => {
    expect(pinyinInitials('通知')).toBe('tz')
    expect(pinyinInitials('终端 回滚')).toBe('zd hg')
    expect(pinyinInitials('定时任务')).toBe('dsrw')
  })

  it('多音字按词覆写：运行族 xíng，行数/换行走名词默认读 háng', () => {
    expect(pinyinInitials('行数')).toBe('hs')
    expect(pinyinInitials('换行')).toBe('hh')
    expect(pinyinInitials('运行')).toBe('yx')
    expect(pinyinInitials('运行时')).toBe('yxs')
    expect(pinyinInitials('运行时长')).toBe('yxsc')
  })

  it('纯英文词不产出（英文走既有子串匹配）', () => {
    expect(pinyinInitials('scrollback theme dark')).toBe('')
    expect(pinyinInitials('OOM')).toBe('')
  })

  it('中英混排：英文词跳过，中文词照常索引', () => {
    expect(pinyinInitials('OOM 死锁 告警 sentinel')).toBe('ss gj')
    expect(pinyinInitials('保留期 retention 留存')).toBe('blq lc')
  })

  it('未收录字符整词跳过，不抛错不产残串', () => {
    expect(pinyinInitials('倬')).toBe('')
    expect(pinyinInitials('通知 倬')).toBe('tz')
    expect(pinyinInitials('')).toBe('')
    expect(pinyinInitials('   ')).toBe('')
  })
})

describe('语料覆盖守卫', () => {
  it('全部 15 分区的 zh 语料（标题+关键词+锚点词）均可派生拼音首字母', () => {
    // P-20261003-147 新增迁移分区（换机配置包导出/导入）——分区数扩容随注记更新
    expect(SETTINGS_TAB_KEYS).toHaveLength(15)
    for (const tab of SETTINGS_TAB_KEYS) {
      const corpus = tabCorpus(tab)
      const dead = corpus
        .split(/\s+/)
        .filter(tok => /\p{Script=Han}/u.test(tok) && pinyinInitials(tok) === '')
      expect(dead, `分区 ${tab} 的词条未被拼音索引覆盖（按读音补 PINYIN_INITIALS）: ${dead.join(' ')}`).toEqual([])
      expect(pinyinInitials(corpus), `分区 ${tab} 首字母索引为空`).not.toBe('')
    }
  })

  it('首字母索引只含小写字母与空格', () => {
    for (const tab of SETTINGS_TAB_KEYS) {
      expect(pinyinInitials(tabCorpus(tab))).toMatch(/^[a-z ]*$/)
    }
  })

  it('任务书样例：tz 命中通知分区的首字母索引', () => {
    expect(pinyinInitials(tabCorpus('notifications'))).toContain('tz')
  })
})

describe('定向查询唯一性守卫（e2e settings-search.spec.ts 依赖）', () => {
  it("'tz' 命中 notifications+sentinel（哨兵关键词表本就含「通知」），'hs' 仅命中 terminal", () => {
    const hits = (q: string) =>
      SETTINGS_TAB_KEYS.filter(tab => pinyinInitials(tabCorpus(tab)).includes(q))
    expect(hits('tz')).toEqual(['notifications', 'sentinel'])
    expect(hits('hs')).toEqual(['terminal'])
  })

  it('控件锚点词条查询→分区唯一（e2e settings-search-anchor.spec.ts 依赖，P-20261005-1 扩容面）', () => {
    // 与 SettingsModal.visibleTabs 同构的分区命中（原分子串 ∨ 拼音首字母）
    const hits = (q: string) => {
      const query = q.toLowerCase()
      return SETTINGS_TAB_KEYS.filter(tab => {
        const corpus = tabCorpus(tab).toLowerCase()
        return corpus.includes(query) || pinyinInitials(corpus).includes(query)
      })
    }
    // 新增锚点词的查询必须唯一落分区（多分区命中时锚定不触发，直达体验断裂）
    expect(hits('字体大小')).toEqual(['terminal'])
    expect(hits('滚动缓冲')).toEqual(['terminal'])
    expect(hits('终端字体')).toEqual(['appearance'])
    expect(hits('用户名')).toEqual(['git'])
    expect(hits('邮箱')).toEqual(['git'])
    expect(hits('添加远程')).toEqual(['remote'])
    expect(hits('agent token')).toEqual(['security'])
    expect(hits('审计')).toEqual(['security'])
    expect(hits('声音')).toEqual(['notifications'])
    expect(hits('免打扰')).toEqual(['notifications'])
    expect(hits('webhook')).toEqual(['notifications'])
    expect(hits('自定义智能体')).toEqual(['general'])
    // P-20261006-49 安全分区锚点补齐（TLS 传输加密/实例间校验/自动锁定）
    expect(hits('传输加密')).toEqual(['security'])
    expect(hits('指纹')).toEqual(['security'])
    expect(hits('自动锁定')).toEqual(['security'])
    // P-20261005-212 光标偏好锚点（形态/闪烁）
    expect(hits('闪烁')).toEqual(['terminal'])
    expect(hits('下划线')).toEqual(['terminal'])
    // 既有断言面不因锚点扩容漂移
    expect(hits('scrollback')).toEqual(['terminal'])
    expect(hits('凭据').length).toBe(2)
  })
})

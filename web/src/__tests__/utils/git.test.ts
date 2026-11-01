import { describe, it, expect } from 'vitest'
import { getStatusColor, getStatusLabel, formatDate, formatDateTime, getLanguageByPath } from '@/utils/git'
import zhCN from '@/locales/zh-CN'

describe('getStatusColor', () => {
  it('Modified 返回绿色', () => expect(getStatusColor('Modified')).toBe('var(--accent-green-dim)'))
  it('Added 返回黄色', () => expect(getStatusColor('Added')).toBe('var(--accent-yellow)'))
  it('Deleted 返回红色', () => expect(getStatusColor('Deleted')).toBe('var(--accent-red)'))
  it('Untracked 返回灰色', () => expect(getStatusColor('Untracked')).toBe('var(--text-dim)'))
  it('Renamed 返回浅蓝', () => expect(getStatusColor('Renamed')).toBe('var(--accent-blue-light)'))
  it('Unmerged 返回橙（冲突示警，P-20261003-136）', () => expect(getStatusColor('Unmerged')).toBe('var(--accent-orange)'))
  it('未知状态返回透明', () => expect(getStatusColor('Unknown')).toBe('transparent'))
  it('undefined 返回透明', () => expect(getStatusColor()).toBe('transparent'))
})

describe('getStatusLabel', () => {
  it('Modified → M', () => expect(getStatusLabel('Modified')).toBe('M'))
  it('Added → A', () => expect(getStatusLabel('Added')).toBe('A'))
  it('Deleted → D', () => expect(getStatusLabel('Deleted')).toBe('D'))
  it('未知返回空字符串', () => expect(getStatusLabel('X')).toBe(''))
  it('缺省（undefined）返回空字符串', () => expect(getStatusLabel()).toBe(''))
})

describe('formatDate', () => {
  it('空字符串返回空', () => expect(formatDate('')).toBe(''))
  it('有效的 ISO 日期返回中文格式', () => {
    // vitest setup 用 mock i18n（t 返回键名）替换了真实 vue-i18n，
    // 这里对齐 zh-CN 文案断言（真实翻译渲染由 E2E 覆盖）
    expect(formatDate(new Date().toISOString())).toBe(zhCN.time.justNow)
  })
  it('无效日期返回原字符串', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })
  it('分钟/小时/天分档按 zh-CN 文案插值（相对时间梯度）', () => {
    const now = Date.now()
    const isoAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
    expect(formatDate(isoAgo(2))).toBe('2分钟前')
    expect(formatDate(isoAgo(59))).toBe('59分钟前')
    expect(formatDate(isoAgo(60 * 3))).toBe('3小时前')
    expect(formatDate(isoAgo(60 * 24 * 5))).toBe('5天前')
  })
  it('超过 30 天落本地日期串（相对时间梯度出口）', () => {
    const d = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    expect(formatDate(d.toISOString())).toBe(d.toLocaleDateString('zh-CN'))
  })
})

describe('formatDateTime', () => {
  it('空字符串返回空', () => expect(formatDateTime('')).toBe(''))
  it('有效日期输出本地时区 YYYY-MM-DD HH:mm:ss', () => {
    // new Date(iso) 与手动构造同参数 Date 时区一致，避免测试机时区差异
    const d = new Date(2026, 8, 12, 17, 41, 5)
    expect(formatDateTime(d.toISOString())).toBe('2026-09-12 17:41:05')
  })
  it('无效日期返回原字符串', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})

describe('getLanguageByPath', () => {
  it('空路径返回 plaintext', () => expect(getLanguageByPath()).toBe('plaintext'))
  it('.ts → typescript', () => expect(getLanguageByPath('src/app.ts')).toBe('typescript'))
  it('.vue → html', () => expect(getLanguageByPath('App.vue')).toBe('html'))
  it('.json → json', () => expect(getLanguageByPath('package.json')).toBe('json'))
  it('.md → markdown', () => expect(getLanguageByPath('README.md')).toBe('markdown'))
  it('.go → go', () => expect(getLanguageByPath('main.go')).toBe('go'))
  it('Dockerfile → dockerfile', () => expect(getLanguageByPath('Dockerfile')).toBe('dockerfile'))
  it('Makefile → makefile（文件名命中，不看扩展名）', () => expect(getLanguageByPath('Makefile')).toBe('makefile'))
  it('.gitignore → plaintext', () => expect(getLanguageByPath('.gitignore')).toBe('plaintext'))
  it('.gitattributes → plaintext', () => expect(getLanguageByPath('.gitattributes')).toBe('plaintext'))
  it('扩展名大小写不敏感（A.MD → markdown）', () => expect(getLanguageByPath('README.MD')).toBe('markdown'))
  it('未知扩展名返回 plaintext', () => expect(getLanguageByPath('data.xyz')).toBe('plaintext'))
})

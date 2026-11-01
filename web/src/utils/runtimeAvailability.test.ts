import { describe, expect, it } from 'vitest'
import { runtimeSelectDisabled, shortVersionLabel } from './runtimeAvailability'

/** runtimeSelectDisabled：镜像服务端创建预检（P-79）的拒绝/豁免口径 */
describe('runtimeSelectDisabled', () => {
  it('可用项恒可选（探测结论与版本探测失败均不禁用）', () => {
    expect(runtimeSelectDisabled({ available: true })).toBe(false)
    expect(runtimeSelectDisabled({ available: true, customCommand: '' })).toBe(false)
  })

  it('缺失 + 裸名默认命令（无覆盖）→ 禁选：显式选择会被预检 400', () => {
    expect(runtimeSelectDisabled({ available: false, defaultCommand: 'claude' })).toBe(true)
    expect(runtimeSelectDisabled({ available: false, defaultCommand: 'aider --model x' })).toBe(true)
    expect(runtimeSelectDisabled({ available: false })).toBe(true)
  })

  it('缺失 + per-runtime 自定义命令覆盖 → 不禁选（targetPrecheckName 豁免：原样启动承诺）', () => {
    expect(runtimeSelectDisabled({ available: false, defaultCommand: 'claude', customCommand: '/opt/wrap.sh --flag' })).toBe(false)
    // 纯空白覆盖 = 服务端 TrimSpace 判空同口径：不构成豁免
    expect(runtimeSelectDisabled({ available: false, defaultCommand: 'claude', customCommand: '   ' })).toBe(true)
  })

  it('缺失 + 命令首词路径形态 → 不禁选（PrecheckRuntime 路径形态豁免：包装脚本）', () => {
    expect(runtimeSelectDisabled({ available: false, defaultCommand: '/home/u/cld.sh' })).toBe(false)
    expect(runtimeSelectDisabled({ available: false, defaultCommand: 'C:\\tools\\aider.exe --model x' })).toBe(false)
    expect(runtimeSelectDisabled({ available: false, defaultCommand: './bin/agent --serve' })).toBe(false)
  })

  it('可用项带覆盖/路径命令同样可选（available 短路）', () => {
    expect(runtimeSelectDisabled({ available: true, defaultCommand: 'claude', customCommand: '/x/y.sh' })).toBe(false)
  })
})

/** shortVersionLabel：--version 首行 → 徽标短文本 */
describe('shortVersionLabel', () => {
  it('取首个点分版本号，忽略前后装饰', () => {
    expect(shortVersionLabel('2.1.3 (Claude Code)')).toBe('2.1.3')
    expect(shortVersionLabel('dsh 0.5.2')).toBe('0.5.2')
    expect(shortVersionLabel('codex-cli 10.20.30 beta')).toBe('10.20.30')
  })

  it('无点分形态回落首个空白分隔词（不臆造）', () => {
    expect(shortVersionLabel('unknown-version')).toBe('unknown-version')
    expect(shortVersionLabel('  v3  ')).toBe('v3')
  })

  it('空输入返回空串（调用方以空值判断不渲染徽标）', () => {
    expect(shortVersionLabel('')).toBe('')
    expect(shortVersionLabel('   ')).toBe('')
  })
})

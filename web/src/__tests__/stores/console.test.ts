import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useConsoleStore, type CommandLog } from '@/stores/console'

describe('consoleStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态为空', () => {
    const store = useConsoleStore()
    expect(store.logs).toEqual([])
  })

  it('addLog 添加日志', () => {
    const store = useConsoleStore()
    const log: CommandLog = { command: 'git', args: 'status', output: 'clean', error: '', workDir: '/tmp', timestamp: new Date().toISOString() }
    store.addLog(log)
    expect(store.logs).toHaveLength(1)
    expect(store.logs[0]?.command).toBe('git')
  })

  it('addLog 超过 200 条时移除最旧日志', () => {
    const store = useConsoleStore()
    for (let i = 0; i < 250; i++) {
      store.addLog({ command: `cmd${i}`, args: '', output: '', error: '', workDir: '', timestamp: '' })
    }
    expect(store.logs.length).toBeLessThanOrEqual(200)
    expect(store.logs[0]?.command).not.toBe('cmd0')
  })

  it('addLog 维持日志顺序', () => {
    const store = useConsoleStore()
    store.addLog({ command: 'first', args: '', output: '', error: '', workDir: '', timestamp: '' })
    store.addLog({ command: 'second', args: '', output: '', error: '', workDir: '', timestamp: '' })
    expect(store.logs[0]?.command).toBe('first')
    expect(store.logs[1]?.command).toBe('second')
  })
})

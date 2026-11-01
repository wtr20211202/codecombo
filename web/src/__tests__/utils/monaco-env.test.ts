import { describe, it, expect, vi } from 'vitest'

// ?worker 导入在 vitest 下解析为「构造时 new Worker(url)」的包装类；
// jsdom 无 Worker，这里放一个可构造的桩记录各语言 label 的构造去向
const constructed: string[] = []
class WorkerStub {
  constructor(url: string) {
    constructed.push(String(url))
  }
}
;(globalThis as unknown as { Worker: typeof WorkerStub }).Worker = WorkerStub

// monaco 官方 getWorker 签名 (moduleId, label)——label 在第二个参数位
type MonacoEnv = { getWorker: (moduleId: unknown, label: string) => WorkerStub }

function env(): MonacoEnv {
  return (self as unknown as Record<string, MonacoEnv>).MonacoEnvironment
}

describe('monaco-env', () => {
  it('模块可导入，且 MonacoEnvironment 已注册 getWorker', async () => {
    const mod = await import('@/utils/monaco-env')
    expect(mod).toBeDefined()
    expect(typeof env().getWorker).toBe('function')
  })

  it('getWorker 按 label 分发语言 worker（json/css/scss/less/html/ts/js），未知 label 落 editor worker', async () => {
    await import('@/utils/monaco-env')
    constructed.length = 0
    expect(env().getWorker('', 'json')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'css')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'scss')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'less')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'html')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'handlebars')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'typescript')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'javascript')).toBeInstanceOf(WorkerStub)
    expect(env().getWorker('', 'coffeescript')).toBeInstanceOf(WorkerStub) // 未知 label 兜底
    expect(constructed).toHaveLength(9)
  })
})

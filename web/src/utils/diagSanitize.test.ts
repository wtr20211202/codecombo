import { describe, expect, it } from 'vitest'
import {
  diagErrorClassOf,
  newClientRequestId,
  sanitizeMessage,
  sanitizeUrlPath,
  sanitizeWsPath,
  truncateChars,
} from './diagSanitize'

describe('sanitizeUrlPath（S1a②：捕获时 URL 模板化）', () => {
  it('绝对 URL 只留 pathname：origin/query/fragment 全剥离', () => {
    expect(sanitizeUrlPath('https://example.com/api/projects/p1/file?path=%2Fhome%2Fu%2Fa.md#x'))
      .toBe('/api/projects/p1/file')
  })

  it('相对路径查询串剥离', () => {
    expect(sanitizeUrlPath('/api/system/logs?q=secret&date=2026-11-25')).toBe('/api/system/logs')
  })

  it('/s/<token> → /s/:token（访客分享链接 token 不入库）', () => {
    expect(sanitizeUrlPath('/s/casttoken00000001')).toBe('/s/:token')
    expect(sanitizeUrlPath('/s/casttoken00000001?theme=dark')).toBe('/s/:token')
  })

  it('/api/share/<token> → /api/share/:token，子路径保留', () => {
    expect(sanitizeUrlPath('/api/share/sessiontoken0001')).toBe('/api/share/:token')
    expect(sanitizeUrlPath('/api/share/sessiontoken0001/messages')).toBe('/api/share/:token/messages')
  })

  it('UUID 段 → :id', () => {
    expect(sanitizeUrlPath('/api/projects/6f6b0f4e-1234-4abc-9def-0123456789ab/file'))
      .toBe('/api/projects/:id/file')
  })

  it('16 hex 段 → :id（不误伤更短/更长的普通段）', () => {
    expect(sanitizeUrlPath('/api/tokens/0123456789abcdef/status')).toBe('/api/tokens/:id/status')
    expect(sanitizeUrlPath('/api/tokens/0123456789abcde/status')).toBe('/api/tokens/0123456789abcde/status')
  })

  it('远程实例代理前缀模板化', () => {
    expect(sanitizeUrlPath('/proxy/inst-abc/api/projects/p1/status'))
      .toBe('/proxy/:instanceId/api/projects/p1/status')
  })

  it('非 URL 文本安全返回（Vue errorHandler 的 vue:info 形态）', () => {
    expect(sanitizeUrlPath('vue:render function')).toBe('vue:render function')
    expect(sanitizeUrlPath('')).toBe('')
  })
})

describe('sanitizeWsPath（S1a④：WS URL 模板化）', () => {
  it('终端通道：协议/主机/query 剥离，id 模板化', () => {
    expect(sanitizeWsPath('ws://127.0.0.1:9999/ws/terminal/t-123?browserId=abc')).toBe('/ws/terminal/:id')
    expect(sanitizeWsPath('wss://example.com/ws/projects/6f6b0f4e-1234-4abc-9def-0123456789ab'))
      .toBe('/ws/projects/:projectId')
  })

  it('proxy 远程通道：实例段与尾部资源段双模板化', () => {
    expect(sanitizeWsPath('ws://h/ws/proxy/inst-1/terminal/t-9')).toBe('/ws/proxy/:instanceId/terminal/:id')
    expect(sanitizeWsPath('ws://h/ws/proxy/inst-1/remote-terminal/s-9')).toBe('/ws/proxy/:instanceId/remote-terminal/:id')
    expect(sanitizeWsPath('ws://h/ws/proxy/inst-1/projects/p-9')).toBe('/ws/proxy/:instanceId/projects/:projectId')
  })

  it('部署/克隆/通知/ops 固定通道', () => {
    expect(sanitizeWsPath('ws://h/ws/deploy/task-1')).toBe('/ws/deploy/:taskId')
    expect(sanitizeWsPath('ws://h/ws/clone/task-2')).toBe('/ws/clone/:taskId')
    expect(sanitizeWsPath('ws://h/ws/notifications')).toBe('/ws/notifications')
    expect(sanitizeWsPath('ws://h/ws/ops-channel?browserId=b1')).toBe('/ws/ops-channel')
  })
})

describe('sanitizeMessage（S1a②：去绝对路径 + 截断）', () => {
  it('Windows 盘符路径 → <path>', () => {
    const out = sanitizeMessage('open failed: C:\\Users\\alice\\project\\secret.txt')
    expect(out).toContain('<path>')
    expect(out).not.toContain('alice')
  })

  it('UNC 路径 → <path>', () => {
    const out = sanitizeMessage('share \\\\host\\share\\dir\\file.txt denied')
    expect(out).toContain('<path>')
    expect(out).not.toContain('host\\share')
  })

  it('POSIX 系统目录路径 → <path>', () => {
    const out = sanitizeMessage('read /home/alice/app/data.json failed')
    expect(out).toContain('<path>')
    expect(out).not.toContain('alice')
  })

  it('普通 API 路径与网络文案不被误吞', () => {
    expect(sanitizeMessage('Request failed with status code 500')).toBe('Request failed with status code 500')
    expect(sanitizeMessage('GET /api/projects/p1/file')).toBe('GET /api/projects/p1/file')
  })

  it('按字符上限截断（默认 500 / 自定义 200）', () => {
    expect(truncateChars('a'.repeat(600), 500)).toHaveLength(500)
    expect(sanitizeMessage('x'.repeat(600), 200)).toHaveLength(200)
  })

  it('非字符串安全转换', () => {
    expect(sanitizeMessage(undefined)).toBe('')
    expect(sanitizeMessage({ toString: () => 'obj message' })).toBe('obj message')
  })
})

describe('newClientRequestId（S1a①：客户端 rid 形态）', () => {
  it('8~64 位 [A-Za-z0-9_-]（服务端 middleware.RequestID 上游校验口径）', () => {
    for (let i = 0; i < 20; i++) {
      const rid = newClientRequestId()
      expect(rid).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    }
  })
})

describe('diagErrorClassOf（S1a③：六值分类）', () => {
  it('离线优先归 offline', () => {
    expect(diagErrorClassOf({ message: 'Network Error' }, false)).toBe('offline')
  })
  it('超时（ECONNABORTED / ETIMEDOUT / timeout 文案）', () => {
    expect(diagErrorClassOf({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }, true)).toBe('timeout')
    expect(diagErrorClassOf({ code: 'ETIMEDOUT' }, true)).toBe('timeout')
  })
  it('无响应 = network；4xx/5xx 分开', () => {
    expect(diagErrorClassOf({ message: 'Network Error' }, true)).toBe('network')
    expect(diagErrorClassOf({ response: { status: 404 } }, true)).toBe('http4xx')
    expect(diagErrorClassOf({ response: { status: 502 } }, true)).toBe('http5xx')
    expect(diagErrorClassOf({ response: { status: 200 } }, true)).toBe('unknown')
  })
  it('空错误归 unknown（脚本/Promise 错误共用）', () => {
    expect(diagErrorClassOf(null, true)).toBe('unknown')
  })
})

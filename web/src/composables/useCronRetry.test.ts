import { describe, expect, it } from 'vitest'
import { parseCronRetryPayload } from './useCronRetry'

// cron-retry 通知 payload 解析（P-20261006-14）：与服务端 notifyLaunchFailed
// 落档形态（JSON {cronId,slot}）互为镜像——合法载荷解出双值，非法 JSON /
// 缺 cronId 一律 null（陈旧/损坏通知不可重试，调用方就地提示不发无效请求）
describe('parseCronRetryPayload', () => {
  it('合法载荷：解出任务 ID 与槽点', () => {
    expect(parseCronRetryPayload('{"cronId":"sc_cron_abc","slot":"2026-10-13T02:00:00+08:00"}'))
      .toEqual({ cronId: 'sc_cron_abc', slot: '2026-10-13T02:00:00+08:00' })
  })

  it('缺 slot 容忍（slot 信息性，cronId 是寻址锚）', () => {
    expect(parseCronRetryPayload('{"cronId":"sc_cron_x"}')).toEqual({ cronId: 'sc_cron_x', slot: undefined })
  })

  it('非法 JSON / 缺 cronId / 空串 / 非对象 → null', () => {
    expect(parseCronRetryPayload('not-json')).toBeNull()
    expect(parseCronRetryPayload('{"slot":"2026-10-13T02:00:00Z"}')).toBeNull()
    expect(parseCronRetryPayload('{"cronId":""}')).toBeNull()
    expect(parseCronRetryPayload('{"cronId":123}')).toBeNull()
    expect(parseCronRetryPayload('')).toBeNull()
    expect(parseCronRetryPayload('null')).toBeNull()
  })

  it('slot 非字符串不透传（形状防御）', () => {
    expect(parseCronRetryPayload('{"cronId":"sc_cron_x","slot":42}'))
      .toEqual({ cronId: 'sc_cron_x', slot: undefined })
  })
})

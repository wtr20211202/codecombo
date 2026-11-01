import type { APIRequestContext } from '@playwright/test'
import { expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API_BASE } from './api-base'
import { DEFAULT_PASSWORD } from './helpers'
import { serverPath } from './dualpath'

/**
 * E2E API 级原语共享层（与 helpers.ts 的 UI 助手分层，P-20261004-48）：
 * 「经 API 直建 agent 会话」曾是各 spec 高频自写原语——同名 createAgentSession
 * 在十余个 spec 内签名互异地重定义，新 spec「抄最近的」让漂移持续繁殖。
 * 这里收敛为超集签名；spec 内再定义与共享层导出同名的函数会被
 * check-e2e-conventions 的 shared-export-shadow 规则 warn。
 */

/**
 * 临时目录工厂：收编「os.tmpdir() + 前缀拼装 + mkdirSync recursive」内联模式。
 * 固定路径幂等（重跑复用同目录，不随运行次数膨胀），前缀按 spec/用途起名
 * 防互踩。注意双路径纪律：交服务端的路径须经 serverPath() 翻译——
 * createAgentSessionApi 内部已处理，直接消费本工厂返回值的调用方自行负责
 */
export function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), prefix)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 每次 createAgentSessionApi 现取现用（与各 spec 既有 unlockHeaders 同口径）：
// /api/lock/unlock 无限流、锁配置被其他 spec 切换后旧 token 失效也无需自愈逻辑
async function lockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  expect(res.ok(), `unlock failed: ${res.status()}`).toBeTruthy()
  const token = ((await res.json()) as { token?: string }).token || ''
  expect(token, 'unlock 应回 token').not.toBe('')
  return { 'X-Lock-Token': token }
}

export interface CreateAgentSessionOpts {
  /** 会话名（列表/UI 断言按名锚定，API 层必填） */
  name: string
  /** 运行时；缺省 'shell'（纯终端会话，确定性可跑不拉真实智能体 CLI） */
  runtime?: string
  /** 会话 cwd（本地形态，内部自动 serverPath 翻译）；缺省自动建临时目录
   *  （shell 会话 cwd 须真实存在的既有语义）；显式传 '' 保持无 cwd 语义
   *  （claude 等自管运行时会话忽略 dir） */
  dir?: string
  /** 启动参数（自定义运行时命令覆盖等）；显式传 '' 与缺省省略均原样透传 */
  launchArgs?: string
  /** 会话级 shell 覆盖（P-20261004-57，仅 runtime=shell 生效；服务端 LookPath
   *  校验失败回 400）：传 shellint 不支持的 shell（win=cmd.exe / linux=/bin/sh）
   *  可构造「无 shell 集成」形态会话（OSC 133 依赖族的反向对照，P-20261004-90） */
  shell?: string
}

export interface CreatedAgentSession {
  id: string
  /** 服务端响应 data 原样（响应键集本身是被断言对象时用，勿中间映射） */
  data: Record<string, unknown>
  /** 实际使用的本地 cwd（dir 缺省自动建目录时返回该目录，供调用方登记清理） */
  dir: string
}

/**
 * 经 API 直建 agent 会话（kind=agent，POST /api/terminals）——超集签名收编
 * 各 spec 重定义的 createAgentSession 五花形态：headers 由内部 unlock 承接、
 * dir 缺省自动 makeTempDir、路径经 serverPath 翻译（双路径纪律）、launchArgs
 * 可选。断言口径 = 2xx + 服务端回非空 id；会话出现在列表的既有 sanity 查证
 * 由调用方按需自接（GET /api/terminals 按名过滤）
 */
export async function createAgentSessionApi(
  request: APIRequestContext,
  opts: CreateAgentSessionOpts,
): Promise<CreatedAgentSession> {
  const headers = await lockHeaders(request)
  const dir = opts.dir !== undefined ? opts.dir : makeTempDir(`sc-agent-session-${opts.name}`)
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: {
      kind: 'agent',
      name: opts.name,
      runtime: opts.runtime ?? 'shell',
      dir: serverPath(dir),
      ...(opts.launchArgs !== undefined ? { launchArgs: opts.launchArgs } : {}),
      ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    },
  })
  expect(res.ok(), `agent 会话 ${opts.name} 创建失败: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { data?: { id?: string } & Record<string, unknown> }
  const id = body.data?.id || ''
  expect(id, `agent 会话 ${opts.name} 应创建成功（服务端回 id）`).not.toBe('')
  return { id, data: body.data ?? {}, dir }
}

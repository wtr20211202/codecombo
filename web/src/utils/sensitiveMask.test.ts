/// <reference types="node" />
// 语料一致性用例读 Go 侧共享 fixture（server/mask/testdata/，跨包根路径）——
// 该文件在 tsconfig.app 的 dom 类型域内，node 内建类型经此引用按文件注入
import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maskApprovalSecrets, maskSensitive, setCustomSensitivePatterns, SECRET_HINT_TAIL_CHARS, secretHintInTail, SENSITIVE_MASK } from './sensitiveMask'

// 敏感值遮蔽共享模块单测（P-20261002-108）：
// 模式集权威定义的回放侧验证。与服务端 tap 层（server/mask/mask.go）
// 同一 fixture 语料互锁——本文件覆盖模式形态/边界（全量文本维度），流式
// 跨块维度由 mask_test.go 覆盖；改模式集须双侧同步。

describe('模式① sc?_ 系标识', () => {
  it('遮蔽 sca_ 智能体令牌 / scl_ 解锁令牌（整段含前缀）', () => {
    expect(maskSensitive('token=sca_abc123ABC next')).toBe('token=*** next')
    expect(maskSensitive('export CC_LOCK_TOKEN=scl_deadbeef00')).toBe('export CC_LOCK_TOKEN=***')
    expect(maskSensitive('sca_8f3a2b1c4d5e4f6a8b7c9d0e1f2a3b4c')).toBe(SENSITIVE_MASK)
  })
  it('部分形态不误伤（值段缺位 / 非小写通配位 / 复合词）', () => {
    expect(maskSensitive('scale_1 scx_; sc_ap-id sc_ sc_a')).toBe('scale_1 scx_; sc_ap-id sc_ sc_a')
  })
})

describe('模式② password/token 赋值形态', () => {
  it('键名+分隔符保留、值整段替换（保留证据可读性）', () => {
    expect(maskSensitive('password=hunter2')).toBe('password=***')
    expect(maskSensitive('export PASSWD=x9!a')).toBe('export PASSWD=***')
    expect(maskSensitive('--token=abc123 done')).toBe('--token=*** done')
  })
  it('大小写不敏感；YAML/JSON 冒号形态（引号值含空白整段替换）', () => {
    expect(maskSensitive('PASSWORD=hunter2')).toBe('PASSWORD=***')
    expect(maskSensitive('"token": "abc def"')).toBe('"token": ***')
    expect(maskSensitive("db.password: p@ss w0rd")).toBe('db.password: *** w0rd')
    expect(maskSensitive("token='abc def' done")).toBe('token=*** done')
  })
  it('词边界：复合标识符内的键名片段不是赋值', () => {
    expect(maskSensitive('my_token=abc tokenizer=1 passwords=2')).toBe('my_token=abc tokenizer=1 passwords=2')
    expect(maskSensitive('password policy: strict')).toBe('password policy: strict')
    expect(maskSensitive('token=')).toBe('token=')
  })
  it('同一行多个赋值各自遮蔽', () => {
    expect(maskSensitive('password=a token=b pwd=c')).toBe('password=*** token=*** pwd=***')
  })
  it('ANSI SGR 紧贴键名（着色回显）：序列保真、值遮蔽（三态边界第三态）', () => {
    expect(maskSensitive('\x1b[93mecho \x1b[37mPASSWORD=hunter2')).toBe('\x1b[93mecho \x1b[37mPASSWORD=***')
    expect(maskSensitive('\x1b[?25l\x1b[37mAKIAIOSFODNN7EXAMPLE')).toBe('\x1b[?25l\x1b[37m***')
  })
})

describe('模式③ AKIA 类云 key', () => {
  it('AKIA/ASIA + 16 位大写数字整段替换', () => {
    expect(maskSensitive('aws_access_key_id=AKIAIOSFODNN7EXAMPLE')).toBe('aws_access_key_id=***')
    expect(maskSensitive('key ASIAIOSFODNN7EXAMPLE ok')).toBe('key *** ok')
  })
  it('长度/大小写/边界不符不误伤', () => {
    expect(maskSensitive('AKIAIOSFODNN7EXAMPL')).toBe('AKIAIOSFODNN7EXAMPL')
    expect(maskSensitive('AKIAIOSFODNN7EXAMPLEX')).toBe('AKIAIOSFODNN7EXAMPLEX')
    expect(maskSensitive('akiaiosfodnn7example')).toBe('akiaiosfodnn7example')
    expect(maskSensitive('xAKIAIOSFODNN7EXAMPLE')).toBe('xAKIAIOSFODNN7EXAMPLE')
  })
})

describe('模式集组合与不误伤', () => {
  it('三类模式同一行并存全部遮蔽', () => {
    expect(maskSensitive('password=hunter2 scl_locktok AKIAIOSFODNN7EXAMPLE plain')).toBe(
      'password=*** *** *** plain',
    )
  })
  it('普通文本不动（误伤防护语料）', () => {
    expect(maskSensitive('git push origin main && npm run check')).toBe('git push origin main && npm run check')
    expect(maskSensitive('scale_value scx_; CC_LOCK_TOKEN=plain 中文输出保持原样')).toBe(
      'scale_value scx_; CC_LOCK_TOKEN=plain 中文输出保持原样',
    )
  })
})

// ============== 审批面密钥脱敏（P-20261003-197） ==============
// 与 server/mask/redact_test.go 同一语料互锁（改任一侧同步另一侧）

describe('maskApprovalSecrets 模式④ 已知密钥前缀', () => {
  it('前缀保留 + 值段 *** + 尾 4（首尾可读性）', () => {
    // 动机样例：curl 带 Bearer sk- 令牌（OpenAI 系）
    expect(maskApprovalSecrets('curl -H "Authorization: Bearer sk-proj-abc123XYZdef456GHI789" api.example.com')).toBe(
      'curl -H "Authorization: Bearer sk-***I789" api.example.com',
    )
    expect(maskApprovalSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe('ghp_***3456')
    expect(maskApprovalSecrets('xoxb-123456789012-abcdef')).toBe('xoxb-***cdef')
    expect(maskApprovalSecrets('glpat-abcdefghij1234')).toBe('glpat-***1234')
    expect(maskApprovalSecrets('npm_f1e2d3c4b5a69788')).toBe('npm_***9788')
    expect(maskApprovalSecrets('sk_live_abcdefghijklmnopqrst')).toBe('sk_live_***qrst')
  })
  it('值段不足 12 / 词字符内嵌 "sk-" 嵌段不误遮', () => {
    expect(maskApprovalSecrets('sk-short1')).toBe('sk-short1')
    expect(maskApprovalSecrets('task-20241103-0012345')).toBe('task-20241103-0012345')
  })
  it('多字节边界字符（中文标点）完整还原（与 redact_test.go 回归语料互锁）', () => {
    expect(maskApprovalSecrets('部署触发：ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe('部署触发：ghp_***3456')
  })
})

describe('maskApprovalSecrets 模式⑤ 高熵长串', () => {
  it('三类字符齐备才遮，首 4 尾 4 保留', () => {
    expect(maskApprovalSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe('eyJh***VCJ9')
  })
  it('误判容忍：git SHA（纯 hex）/时间戳段/路径零误伤', () => {
    expect(maskApprovalSecrets('a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e')).toBe(
      'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e',
    )
    expect(maskApprovalSecrets('task-20241103-0012345678901234')).toBe('task-20241103-0012345678901234')
    expect(maskApprovalSecrets('/home/user/project/src/main.go')).toBe('/home/user/project/src/main.go')
  })
})

describe('maskApprovalSecrets 与 P-108 模式集叠加', () => {
  it('①sc 令牌 ②赋值形态照旧整段遮蔽，④补 Bearer 形态', () => {
    expect(maskApprovalSecrets('password=hunter2 scl_locktok sk-abcdefghijklmnopqrst')).toBe(
      'password=*** *** sk-***qrst',
    )
  })
  it('普通命令语境零改动（误伤防护语料）', () => {
    expect(maskApprovalSecrets('git push origin main && npm run check')).toBe('git push origin main && npm run check')
  })
})

// ============== 会话出域敏感内容自动检测（P-20261003-207） ==============
describe('secretHintInTail 出域检测', () => {
  it('命中各模式族：sc 令牌 / 赋值形态 / 已知前缀 → true', () => {
    expect(secretHintInTail('some output\ntoken=sca_deadbeef01\n$ ')).toBe(true)
    expect(secretHintInTail('export PASSWORD=hunter2\n')).toBe(true)
    expect(secretHintInTail('curl -H "Authorization: Bearer sk-abcdefghijklmnopqrst"')).toBe(true)
    expect(secretHintInTail('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(true)
  })
  it('普通输出零误报（提示词/普通命令/git SHA）', () => {
    expect(secretHintInTail('build finished in 3.2s\ngit push origin main\n')).toBe(false)
    expect(secretHintInTail('password policy: strict; my_token=abc tokenizer=1')).toBe(false)
    expect(secretHintInTail('a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e')).toBe(false)
  })
  it('尾窗有界：命中在窗外不报，窗内报；空/短文本安全', () => {
    const prefix = 'x'.repeat(SECRET_HINT_TAIL_CHARS)
    expect(secretHintInTail(`token=hunter2\n${prefix}`)).toBe(false) // 命中在窗外（头部被裁）
    expect(secretHintInTail(`${prefix}\ntoken=hunter2`)).toBe(true) // 命中在窗内（尾部）
    expect(secretHintInTail('')).toBe(false)
    expect(secretHintInTail('plain line')).toBe(false)
  })
})

// ============== 自定义敏感模式（P-20261006-11，双端同源） ==============
// 与 server/mask/corpus_test.go / server/mask/custom_test.go 同步维护

describe('setCustomSensitivePatterns 注入与遮蔽', () => {
  // 进程态模块：用例自清回空，防污染其他用例的纯内置基线
  afterEach(() => {
    setCustomSensitivePatterns([])
  })

  it('无捕获组模式：命中段整段 ***；空列表/清空回落纯内置', () => {
    setCustomSensitivePatterns(['scrt_[A-Za-z0-9]{20,}'])
    expect(maskSensitive('uploading scrt_a1B2c3D4e5F6g7H8A9B2 done')).toBe('uploading *** done')
    expect(secretHintInTail('x scrt_a1B2c3D4e5F6g7H8A9B2 y')).toBe(true)
    // 清空 = 纯通用表现状零变化
    setCustomSensitivePatterns([])
    expect(maskSensitive('uploading scrt_a1B2c3D4e5F6g7H8A9B2 done')).toBe('uploading scrt_a1B2c3D4e5F6g7H8A9B2 done')
  })

  it('有捕获组模式：第 1 组（键名+分隔符）保留、值段 ***（与 Go 侧 $1 语义一致）', () => {
    setCustomSensitivePatterns(['(MY_APP_TOKEN=)([^ ]+)'])
    expect(maskSensitive('deploy MY_APP_TOKEN=abc123 now')).toBe('deploy MY_APP_TOKEN=*** now')
    // 审批面兜底与出域检测打底 maskSensitive——自定义模式自动流入
    expect(maskApprovalSecrets('deploy MY_APP_TOKEN=abc123 now')).toBe('deploy MY_APP_TOKEN=*** now')
    expect(secretHintInTail('deploy MY_APP_TOKEN=abc123')).toBe(true)
  })

  it('编译失败条目跳过不中断其余防护', () => {
    setCustomSensitivePatterns(['(unclosed', 'scrt_[A-Za-z0-9]{20,}'])
    expect(maskSensitive('x scrt_a1B2c3D4e5F6g7H8A9B2 y')).toBe('x *** y')
  })

  it('顺序锚定：内置模式集先行，自定义链随后（前序产物对后续可见）', () => {
    setCustomSensitivePatterns(['password=[A-Za-z0-9]', 'MY_KEY=[A-Za-z0-9]+'])
    // 内置先遮值段 → 自定义模式再见 "password=***"（*=非词字符）不再命中，
    // 键名保留形态不因自定义链重复打码
    expect(maskSensitive('password=scrt_ZZ99ZZ99ZZ99ZZ99ZZ99 tail')).toBe('password=*** tail')
    // 无内置命中的裸值由自定义链兜住（同一链上自定义确有参与）
    expect(maskSensitive('MY_KEY=x1y2z3 tail')).toBe('*** tail')
  })
})

// 双端一致性锚定（P-20261006-11）：语料单文件共享——Go 侧 corpus_test.go 与
// 本用例读同一份 JSON（server/mask/testdata/custom_patterns_corpus.json），
// 各自编译 patterns 注入各自遮蔽链后逐 sample 断言输出一致，任一侧实现/方言
// 假设漂移即红
describe('custom_patterns_corpus 双端一致性', () => {
  const corpusPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../server/mask/testdata/custom_patterns_corpus.json',
  )
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf-8')) as {
    patterns: string[]
    samples: { input: string; masked: string }[]
  }

  it('语料非空（防提取失明）', () => {
    expect(corpus.patterns.length).toBeGreaterThan(0)
    expect(corpus.samples.length).toBeGreaterThan(0)
  })

  it('全链遮蔽输出与 Go 侧共享期望一致', () => {
    setCustomSensitivePatterns(corpus.patterns)
    for (const s of corpus.samples) {
      expect(maskSensitive(s.input)).toBe(s.masked)
    }
  })
})

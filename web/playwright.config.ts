import { defineConfig } from '@playwright/test'
import { resolveBaseURL } from './e2e/global-setup'

export default defineConfig({
  // 套件前对账目标实例 commit ↔ 当前仓库 HEAD（打错实例 fail-fast，P-20261004-50，
  // 降级边界与逃生口见 e2e/global-setup.ts 头注）
  globalSetup: './e2e/global-setup',
  // testDir 指向 web 根，testMatch 同时覆盖 e2e/specs（历史用例）与 tests（业务模块用例）
  testDir: '.',
  testMatch: ['e2e/specs/**/*.spec.ts', 'tests/**/*.spec.ts'],
  timeout: 30000,
  // 负载敏感的时序型 flake（重负载下首跑偶发超时）重跑一次即绿；
  // 确定性失败重跑仍红，会计入失败。flaky 结果在报告中单独标注可审计
  retries: 1,
  // 串行执行：全部用例共享同一个 :9999 服务实例（uiState / 锁定开关 / 项目列表
  // 均为服务端全局状态），并行 worker 必然互相踩踏——宁慢勿flaky
  workers: 1,
  use: {
    // E2E 默认走构建产物（simple-coding.exe :9999，前端通过 go:embed 嵌入）
    // 如需指向 dev server，用 PLAYWRIGHT_BASE_URL 环境变量覆盖。
    // 默认值解析收敛到 global-setup.resolveBaseURL 单点（对账与请求同源）；
    // 全局 setup 会把实例与 HEAD 的错配在套件前 fail-fast，静默缺省不再无代价
    baseURL: resolveBaseURL(),
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
    // 全套件断言为中文 UI；locale 同时决定 HTTP Accept-Language——服务端
    // 默认会话命名（defaultSessionNumberedName）按请求语言生成「终端 1/
    // Terminal 1」，不固定会导致按名断言随浏览器默认 locale（en-US）漂移
    locale: 'zh-CN',
  },
  // 不再用 webServer 自动拉起 dev server：CI/本地均假定 simple-coding 已在 :9999 运行
})

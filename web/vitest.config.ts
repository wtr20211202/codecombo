import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    globals: true,
    css: false,
    // 限 2 个 worker：WSL2/drvfs 挂载下 forks worker 冷启动可达 60s（vitest
    // START_TIMEOUT 硬编码 60s 不可配），默认按 CPU 数（本机 32）并发启动互相
    // 争用 IO，实测稳定超时 2-3 个 worker 报 Unhandled Error → exit 1。
    // maxWorkers=2 实证 Linux 侧全量 352 用例零超时（Windows 侧无回归）。
    maxWorkers: 2,
    coverage: {
      // 常开：npm run check 的 vitest run 即产出报告并执行门槛校验
      enabled: true,
      // utils/ 纯函数覆盖率门槛（P-20261003-206）：报告面只收 utils/，与
      // thresholds 的 'src/utils/**' 目录键同域——新增 util 不写测试即拉低
      // 报告数值触门槛红，防新 util 裸奔。
      include: ['src/utils/**'],
      provider: 'v8',
      // reporter 默认 text + html；text 摘要进 CI 终端、html 落 coverage/
      reporter: ['text', 'html'],
      thresholds: {
        // 数值 = 实测基线 +10 个百分点（P-20261003-206 任务书③「从现状+10%
        // 起步」），向下取整留浮点余量。基线实测（2026-10-07，补测前全量
        // vitest run --coverage）：statements 83.49 / branches 82.71 /
        // functions 82.69 / lines 85.23。缺口补测（含 draftDb 内存 IDB 桩）
        // 后达成值见 npm run check 的 coverage 表；上调门槛时先跑全量实测
        // 再定数值，避免无余量的贴线门槛。
        'src/utils/**': {
          statements: 93,
          branches: 92,
          functions: 92,
          lines: 95,
        },
      },
    },
  },
})

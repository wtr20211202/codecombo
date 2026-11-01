import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 不开 changeOrigin（P-20261019-2）：LockCSRF 对写方法做 Origin↔Host 同源
      // 校验，changeOrigin 会把 Host 改写成 9999 而浏览器 Origin 仍是 5173——
      // dev 模式全部写请求被 403。保留 Host=5173 与 /ws 代理（无 changeOrigin，
      // WS SameOrigin 依赖它）同一线；后端不路由虚拟主机，BaseURL 示例文本
      // 在 dev 下指向 5173 反而更正确
      '/api': {
        target: 'http://localhost:9999',
      },
      '/ws': {
        target: 'ws://localhost:9999',
        ws: true,
      },
      // 分享访客面同源路径（P-20261020-2）：dev 页面 origin 是 5173，分享链接
      // 按当前 origin 生成时必须经 vite 转到 Go 主引擎（/s/* 与访客页 xterm
      // 三件）；只代理三个精确资产名，不吞主应用 /assets/ 产物。
      // 键必须是正则 '^/s/'：vite 对字符串键做前缀匹配，裸 '/s' 会连
      // /settings、/share 等主应用路由一并代理走（dev 页面直接白屏）
      '^/s/': {
        target: 'http://localhost:9999',
        changeOrigin: true,
      },
      '/assets/xterm.js': { target: 'http://localhost:9999', changeOrigin: true },
      '/assets/addon-fit.js': { target: 'http://localhost:9999', changeOrigin: true },
      '/assets/xterm.css': { target: 'http://localhost:9999', changeOrigin: true },
      // 端口预览回环反代（dev 模式与 go:embed 产物行为一致）；预览 dev server
      // 自身（如 5173）时浏览器→vite→Go→回 vite，路径前缀已剥不成环。
      // changeOrigin 同 /api 不开：预览面写方法过 LockCSRF 同源校验（P-20261019-2）
      '/preview': {
        target: 'http://localhost:9999',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/vue') || id.includes('node_modules/vue-router') || id.includes('node_modules/pinia')) return 'vendor-vue'
          // naive-ui 不再手动并单 chunk（915KB 全量进首屏 preload 链）：
          // 交给 rollup 自然分包——按真实引用图把 App 根用到的少量组件与其余
          // 组件的共享内部模块拆成多个小 chunk，首屏只付 NConfigProvider/
          // message/dialog 等实际用到的部分。构建后经 e2e 冒烟（core-workflow/
          // terminal-theme）验证组件初始化顺序无回归
          if (id.includes('node_modules/@xterm')) return 'vendor-xterm'
          if (id.includes('node_modules/axios') || id.includes('node_modules/marked') || id.includes('node_modules/dompurify')) return 'vendor-utils'
          // 注意：不要把 monaco-editor 拆独立 chunk——官方 nls 语言包
          // （nls.messages.<locale>.js，经 monaco-nls.ts 的 ensureMonacoNls
          // 先于 monaco 主模块求值）与 monaco 核心的求值顺序对 chunk 边界
          // 敏感，拆分会破坏原生菜单/查找替换的本地化（e2e 回归验证）
        },
      },
      onwarn(warning, warn) {
        if (warning.message?.includes?.('INVALID_ANNOTATION')) return
        warn(warning)
      },
    },
  },
})

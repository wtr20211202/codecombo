// E2E API 基地址：与 playwright.config 的 baseURL 同源（可用 PLAYWRIGHT_BASE_URL 覆盖）。
// 历史实现把 http://localhost:9999 硬编码在各 spec 里——隔离端口运行 e2e 时
// 这些请求会打到 9999 上的无关实例，必须统一从这里取
export const API_BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

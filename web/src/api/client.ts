// API 客户端统一入口（兼容桶）。
// Phase B 领域拆分：基础设施在 ./http，领域 API 在 ./domains/*。
// 本文件保持既有导入面不变（`from '@/api/client'` 与默认导入照常可用），
// 新代码建议直接从对应领域文件导入。
export * from './http'
export * from './domains/git'
export * from './domains/terminal'
export * from './domains/remote'
export * from './domains/deploy'
export * from './domains/credentials'
export * from './domains/system'
export * from './domains/share'
export * from './domains/agentcron'
export * from './domains/compare'
export * from './domains/sync'
export { default } from './http'

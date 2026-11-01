import type { Component } from 'vue'
import {
  ChatbubblesOutline,
  RocketOutline,
  ShieldCheckmarkOutline,
  GitBranchOutline,
  ShareSocialOutline,
} from '@vicons/ionicons5'

/**
 * 导出中心域注册表（P-20261003-266）：各域导出入口聚合面板的单一事实源。
 * 新增域 = 此表加一条 + 两个 locale 的 exportCenter.domains.<id>.* 词条
 * （已落地时再在 ExportCenterModal 宿主的跳转分发补一个 case），不散落硬编码。
 *
 * 「已落地」= 当前 HEAD 已有真实导出入口可跳（真入口）；false = 渐进接线占位
 * （面板仍展示该域，禁用态注明未落地——发现面先行，入口随后补）。
 */
export interface ExportDomainDef {
  /** 域 id：i18n 键 exportCenter.domains.<id>.* 与宿主跳转分发的锚点 */
  id: string
  /** 是否已有落地导出入口（false = 占位展示，渐进接线） */
  landed: boolean
  icon: Component
}

export const EXPORT_DOMAINS: ExportDomainDef[] = [
  // 会话：回放页导出 Markdown/JSONL 下拉 + 会话中心批量 zip 归档（agent 管理页）
  { id: 'session', landed: true, icon: ChatbubblesOutline },
  // 部署：部署任务日志 txt 留档下载（设置·远程部署）
  { id: 'deploy', landed: true, icon: RocketOutline },
  // 审计：审计日志 CSV（设置·安全）+ 裁决历史 CSV（审批卡堆）
  { id: 'audit', landed: true, icon: ShieldCheckmarkOutline },
  // 变更：未提交变更导出 git diff 格式补丁（变更面板工具下拉）
  { id: 'changes', landed: true, icon: GitBranchOutline },
  // 分享归档：目录分享的打包下载目前在访客侧（分享子服务），宿主侧无入口——占位
  { id: 'shareArchive', landed: false, icon: ShareSocialOutline },
]

/**
 * 最近导出记录的审计动作集合：导出族动作（与 server/store/auditlog.go 常量
 * 同构，前端标签复用既有 audit.action.* 词条，不新增动作）。导出中心拉一页
 * 审计按此过滤——「最近导出」复用审计链路，零新增落盘（提案定案）。
 */
export const EXPORT_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  'claude.export', // 会话导出 Markdown/JSONL
  'claude.export_batch', // 会话批量导出 zip
  'audit.export', // 审计日志 CSV
  'approval.export', // 裁决历史 CSV
  'workspace.export', // 工作区状态备份
  'remotehost.export', // 主机凭据导出
  'file.dirarchive', // 目录打包下载
  'file.batcharchive', // 多选批量归档下载
])

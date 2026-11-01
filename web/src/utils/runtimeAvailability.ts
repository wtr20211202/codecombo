/**
 * 运行时可用态的纯判定/展示 helper（P-20261004-85，新建会话对话框 runtime
 * 选项的可用态徽标与禁选）：禁选判定与服务端创建预检（P-20261003-79，
 * server/api/terminal/terminal.go targetPrecheckName + server/agentops/
 * precheck.go PrecheckRuntime）的拒绝/豁免口径镜像对齐——前端徽标是体验层
 * 非正确性层，服务端预检兜底不变；两处口径改动须同 PR 评估同步。
 */

/** 对话框消费的运行时清单行（/api/agent-runtimes RuntimeRow 的前端子集：
 *  徽标/禁选判定只依赖这四个字段，displayName/version 由调用方另行取用） */
export interface RuntimeAvailabilityInfo {
  /** 服务进程 PATH 视角探测（userbin 链），false = 未检测到 */
  available: boolean
  /** per-runtime 自定义启动命令覆盖（settings.agentLaunchCommands[name]，空 = 用默认命令） */
  customCommand?: string
  /** 交互启动命令：内置运行时为服务端常量裸名；自定义智能体为用户配置命令行 */
  defaultCommand?: string
}

/**
 * 显式选择是否应禁选：可用项恒可选；缺失项仅在「无预检豁免」时禁选——
 * 该形态的显式选择会被服务端预检 400（PrecheckError missing），事前不可点
 * 与提交后报错语义一致（提案①②的「口径对齐」）。豁免链与预检同源：
 *   - per-runtime 自定义启动命令覆盖：原样启动承诺（targetPrecheckName 豁免）；
 *   - 命令首词为路径形态（包装脚本绝对路径，含 \ 与 / 双平台分隔符）：探测
 *     本就不可达，预检不拦（PrecheckRuntime 路径形态豁免）。
 * 为什么豁免项不禁选：db0cef05 曾整体移除禁用（探测失败→禁用→无法在对话框
 * 配置命令→死锁），本判定把「配命令自救」路径精确保留在豁免链里——配了
 * 覆盖命令的运行时恒可选，既不堵自救也不再放出必 400 的死路选择。
 */
export function runtimeSelectDisabled(r: RuntimeAvailabilityInfo): boolean {
  if (r.available) return false
  if ((r.customCommand || '').trim() !== '') return false
  const firstWord = (r.defaultCommand || '').trim().split(/\s+/)[0] || ''
  return !/[/\\]/.test(firstWord)
}

/**
 * 版本短徽标文本：--version 首行常带装饰（「2.1.3 (Claude Code)」/「dsh 0.5.2」），
 * 徽标取首个点分版本号；无点分形态回落首个空白分隔词（不臆造，原样词展示），
 * 空输入返回空串（调用方以空值判断不渲染徽标）。完整首行由调用方放 title
 * 悬停（徽标求短、核对求全）
 */
export function shortVersionLabel(version: string): string {
  const dotted = version.match(/\d+(?:\.\d+)+/)
  if (dotted) return dotted[0]
  return version.trim().split(/\s+/)[0] || ''
}

/** 运行时不可用安装引导锚定的帮助中心 FAQ 条目 id（server/api/help/help.go
 *  的 agent-runtime-install 条目——id 是两处契约，条目迁移须同步）。
 *  消费点：新建会话对话框顶部「全部不可用」提示卡与命令描述区检测说明
 *  （NewSessionDialog / NewSessionAdvancedSections），单点常量防漂移 */
export const HELP_RUNTIME_ENTRY = 'agent-runtime-install'

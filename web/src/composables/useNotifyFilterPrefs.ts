import { watch, type Ref } from 'vue'
import { safeStorage } from '../utils/storage'

// 通知中心过滤选择持久化（P-20261003-173）：分类页签 + 项目下拉的当前选择
// localStorage 记忆——常用过滤组合（「只看某项目 error」）跨页面刷新/重启不再
// 重选。键名沿用 notify-dnd/notify-simple/notify-sound 通知域家族命名。
// 恢复入口零新增 UI：「全部」页签与「全部项目」下拉项即默认档，点选即写回；
// 失效的项目选择（项目删除/其通知清空后候选消失）由 NotificationCenter 既有的
// projectOptions 对账 watch 回落「全部项目」，回落态同样写回持久层——陈旧选择
// 不会在下次启动复活。存储一律走 safeStorage（裸 localStorage 在屏蔽 Cookie/
// 隐私模式下抛 SecurityError 的既有红线）
// P-20261003-187 起载荷增 runtime 键（runtime 过滤 chips 同构）：存量载荷无
// 该键按「全部运行时」起步，读侧逐字段校验，向后兼容零迁移

const STORAGE_KEY = 'notify-filter'

/** 持久化载荷：filter=分类页签键（'all'=全部），project=选中项目 id（''=全部项目），runtime=选中运行时注册名（''=全部运行时） */
export interface NotifyFilterPrefs {
  filter: string
  project: string
  runtime: string
}

function fallback(): NotifyFilterPrefs {
  return { filter: 'all', project: '', runtime: '' }
}

/**
 * 读取持久化的过滤选择。validFilters 传当前页签键清单（组件侧 filters 的
 * key 列表，单一事实源）：存储值不在清单（旧版本残留/手改/键位演进）时按
 * 「全部」起步，绝不带出无效页签——无效分类键会让列表恒为空且无解释。
 * project/runtime 仅做结构校验（非串回落空），其存在性由组件对账 watch 动态
 * 回落（候选清单都从通知条目聚合，历史异步加载后仍有效的选择才站得住）
 */
export function loadNotifyFilterPrefs(validFilters: readonly string[], validRuntimes: readonly string[] = []): NotifyFilterPrefs {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback()
    const { filter, project, runtime } = parsed as Record<string, unknown>
    return {
      filter: typeof filter === 'string' && validFilters.includes(filter) ? filter : 'all',
      project: typeof project === 'string' ? project : '',
      // runtime 注册名清单随条目动态聚合，加载早期常为空清单：空清单只做结构
      // 校验（存在性交给组件对账 watch），非空时按页签同规则拒绝无效键
      runtime:
        typeof runtime === 'string' && (validRuntimes.length === 0 || validRuntimes.includes(runtime))
          ? runtime
          : '',
    }
  } catch {
    return fallback() // 非 JSON 脏数据：默认档起步，不阻断面板
  }
}

/**
 * 过滤选择变更即写持久层（含对账回落的写回；面板开闭不参与——组件常驻
 * App.vue，写发生于状态变更时）。watch 非 immediate：启动恢复不回写，
 * 未动过的默认态不产生存储写入
 */
export function watchNotifyFilterPrefs(filter: Ref<string>, project: Ref<string>, runtime: Ref<string>): void {
  watch([filter, project, runtime], ([f, p, r]) => {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: f, project: p, runtime: r }))
  })
}

import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registeredReconnectDomains } from './reconnectRefetch'

// 域主模块装配导入（P-20261003-235 覆盖面哨兵）：P-20261003-236 落地形态是
// 「注册随域主模块装配期自注册」——本文件的 import 语句本身就是装配动作，
// 模块顶层的 registerReconnectRefetch 在导入期执行。删除任何一个域的注册行
// （如重构 store 时误删）或新增域漏登记，都会让下方键集断言变红。
import './useWebSocket' // project 域（模块顶层注册）
import '../stores/approvals' // approvals 域（模块顶层注册）
import '../stores/asks' // asks 域（模块顶层注册）
import '../stores/terminal-sessions' // terminals 域（模块顶层注册）
import '../stores/assistantTask' // assistantTask 域（模块顶层注册，P-20261004-120）
import { useNotificationStore } from '../stores/notification'

/**
 * 重连补拉注册表覆盖面哨兵（P-20261003-235）
 *
 * 动机：补拉的覆盖对象（哪些域断线重连后必须补拉）此前只有文档约定没有测试
 * 锁定——后续改动可能静默漏掉某类补拉（回归哨兵缺口）。本文件把「注册表当前
 * 键集」与「文档清单」锁成同一份事实：
 * - 键数断言：新增/删除域时数量先行暴露，失败信息直接给出差异；
 * - 键集断言（排序比较，不耦合注册序）：域缺失/改名/多出在此曝光。
 *
 * 有意新增补拉域时的更新义务（三处同步，缺一即是本用例的红）：
 *   1. reconnectRefetch.ts 头注「内建域」文档清单；
 *   2. 本文件的 DOCUMENTED_DOMAINS；
 *   3. 对应域的断连→重连→恢复 e2e 用例（既有族：ws-reconnect-refetch /
 *      ops-reconnect-refetch / reconnect-refetch-coverage）。
 *
 * 与 reconnectRefetch.test.ts 的分工：那份测注册表本体语义（注册/覆盖/遍历/
 * 失败收口），且刻意不 import 域主模块（保持隔离）；本文件反过来以真实装配
 * 为断言对象——两份合起来才是完整锁定面。
 */

/** 文档清单（同步自 reconnectRefetch.ts 头注「内建六域」） */
const DOCUMENTED_DOMAINS = ['project', 'approvals', 'asks', 'notification', 'terminals', 'assistantTask']

// 注册是一次性装配副作用（ESM 模块单例），不能逐用例 reset 再重来——
// 整个文件共享同一份装配结果。notification 域例外于其余四域：注册在 store
// setup 内（闭包持 loadHistory，见 notification.ts 注册处注记），须实例化才入表
// （生产里 App.vue 启动即 init，装配期必然实例化）；axios 已被测试 setup 全局
// mock，实例化不产生真实网络面
setActivePinia(createPinia())
useNotificationStore()

describe('reconnectRefetch 覆盖面哨兵（P-20261003-235）', () => {
  it('内建补拉域全量在表：键数与键集均与文档清单一致（域增删必须显式更新本用例）', () => {
    const keys = registeredReconnectDomains()
    // 键数先行：失败信息直接呈现数量差，指引同步文档清单与 e2e 覆盖
    expect(keys).toHaveLength(DOCUMENTED_DOMAINS.length)
    // 键集（排序比较，不耦合注册序——注册序由域主模块导入顺序决定，非契约）
    expect([...keys].sort()).toEqual([...DOCUMENTED_DOMAINS].sort())
  })
})

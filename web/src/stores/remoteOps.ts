import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 远程运维弹窗全局状态——诊断 / 远程命令执行 / 部署。
 *
 * 弹窗实例挂载在 App 层（全局一次），三类入口共享：
 * - 设置 → 远程部署 → 主机卡片菜单
 * - 远程控制台页的快捷操作
 * - 命令面板「诊断主机 / 远程执行」命令
 */
export const useRemoteOpsStore = defineStore('remoteOps', () => {
  const showDiagnose = ref(false)
  const diagHost = ref<{ id: string; name: string }>({ id: '', name: '' })

  const showExec = ref(false)
  const execHost = ref<{ id: string; name: string }>({ id: '', name: '' })
  const execInitialCmd = ref('')

  // 本地-远端 Git 对照卡（P-20261004-34）：与诊断/远程执行同族的全局弹窗
  const showGitCompare = ref(false)
  const gitCompareHost = ref<{ id: string; name: string }>({ id: '', name: '' })

  // 多主机巡检对比（P-20261004-58）：机队级动作不锚定单台主机，无主机参数
  const showDiagCompare = ref(false)

  // 部署弹窗打开参数走 store 字段（D4：原来是 CustomEvent+setTimeout，
  // 弹窗未挂载或监听器注册晚于事件时目标主机静默丢失）
  const showDeploy = ref(false)
  const deployHostId = ref('')

  function openDiagnose(id: string, name: string) {
    if (!id) return
    diagHost.value = { id, name }
    showDiagnose.value = true
  }

  function openExec(id: string, name: string, initialCmd?: string) {
    if (!id) return
    execHost.value = { id, name }
    execInitialCmd.value = initialCmd || ''
    showExec.value = true
  }

  function openGitCompare(id: string, name: string) {
    if (!id) return
    gitCompareHost.value = { id, name }
    showGitCompare.value = true
  }

  /** 打开多主机巡检对比（主机勾选在弹窗内完成，打开即自动跑一轮） */
  function openDiagCompare() {
    showDiagCompare.value = true
  }

  /** 打开部署弹窗并定位目标主机（与 showDeploy 置位同帧生效，无竞态窗口） */
  function openDeploy(id: string) {
    if (!id) return
    deployHostId.value = id
    showDeploy.value = true
  }

  return {
    showDiagnose,
    diagHost,
    showExec,
    execHost,
    execInitialCmd,
    showGitCompare,
    gitCompareHost,
    showDiagCompare,
    showDeploy,
    deployHostId,
    openDiagnose,
    openExec,
    openGitCompare,
    openDiagCompare,
    openDeploy,
  }
})

package compareexp

// 操作手册分节（P-20261004-72 ④「手册 compareexp 节」）：此前对比实验无手册节
//（P-20261003-46 仅 CLAUDE.md 登记），落盘二阶段是 agent 可直调的工作区破坏性
// 动作，agent 侧可知语义与安全边界——注册一节，/ops-manual 与 SKILL.md 自动包含。

import "codecombo/server/agentops"

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "compareexp", Title: "对比实验（双 agent 竞写与采用落盘）", Order: 73,
		Summary: "同题双开两个 agent 竞写、逐文件三分类对比、采用后一键落盘工作区（回滚/删除带强制备份）",
		Body: `- 对比实验 = 同一 prompt 双开两个 runtime 会话竞写，双侧终结后按各会话
  startHead 快照面取产出并集逐文件三分类：仅 A / 仅 B / 双方（分目录
  dirA/dirB worktree 竞写才能区分「仅某侧」；同目录双侧视图一致全落「双方」）。
- POST /api/compare-experiments   双开发起
  body: {"prompt":"<≤500字节>", "dir":"<可选：共用工作目录>",
         "runtimeA":"claude","runtimeB":"codex",
         "dirA":"<可选：A 侧独立 worktree>","dirB":"<可选：B 侧独立 worktree>"}
- GET  /api/compare-experiments            实验列表
- GET  /api/compare-experiments/:id        详情（含 files 三分类实时计算）
- GET  /api/compare-experiments/:id/filediff?side=a&file=x[&status=?]
        单文件「基线 vs 侧产出」unified diff（untracked 传 status=? 走合成）
- GET  /api/compare-experiments/:id/applies/:aid/patch   单次 apply 的还原补丁+备份字节
- DELETE /api/compare-experiments/:id      删除实验（级联清账 applies 备份）
- POST /api/compare-experiments/:id/adopt  采用（两阶段）
  body: {"side":"a|b|""}                      = annotate（仅标注，缺省）
  body: {"side":"a|b","mode":"apply"}         = 落盘（工作区收尾自动化）
  apply 语义：采用侧独有文件保留；另一侧独有 tracked 回滚到其自身基线
  （--binary 还原补丁合并单补丁 git apply -R，全有或全无）；另一侧独有
  untracked 删除；双方文件无操作注记（同目录形态本就无「他侧独有」破坏动作）。
- apply 安全边界（不可绕过）：
  ① 强制备份前置：执行前把还原补丁 + 待删 untracked 字节落库（车道 1 kind
    expapply），超 8MB 拒绝执行——宁拒勿删；
  ② 指纹对账：采用标注时点快照行动文件 sha256，标注后文件被手改/增减即整体
    拒绝（稳定标记 "compare experiment workspace changed since adoption"，
    工作区一个字节不动；重新标注即可刷新参照系）；
  ③ 未结算拒绝：双侧回执未齐且会话仍存活时不执行（防对活体 agent 工作区竞态；
    shell 降级无回执形态关闭会话即可落盘）；
  ④ 备份可查：GET /api/compare-experiments/:id/applies（记录列表）与
    .../applies/:aid/patch（还原补丁 + 备份字节）；实验删除级联清账。
  分目录「双方」文件的跨目录内容裁决为二期边界（当前保持现状并注记）。
- 典型组合：双开竞写 → 双侧 done → GET 详情看三分类与逐文件 diff →
  adopt {"side":"胜者","mode":"apply"} → 通知中心收「保留 N/回滚 M/删除 K」
  回执，败者侧工作区回到基线、status 干净。
- 事件：完成链回执落位（任一侧 Result 变化，双侧齐备即翻 ready）即经
  ops-channel 广播 experiment.changed，载荷 {"id","status","resultA","resultB"}
  ——agent 自动化脚本监听该事件即知竞写进度（免轮询 GET 详情；事件是
  通知不是快照，权威状态仍以 GET 为准）。`,
	})
}

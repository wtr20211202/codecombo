package terminal

// 多终端广播写入（P-20261003-288 舰队式批量输入）：POST /api/terminals/broadcast-write
// 的会话遍历层。HTTP handler 只做参数校验与响应整形，逐会话写入收口在 Manager
// 方法上——单测可用内存态 Manager 直注假连接验证，不经 PTY 真起 shell。

// BroadcastResult 单次广播的逐会话回告：written=成功写入数；
// missing=不存在的会话 id（跳过并回告，整批不视为错误）；
// failed=存在但写入失败的 id（已关闭/未附着/PTY 写错误）。
// 三者之和 = 去重后的请求 id 数
type BroadcastResult struct {
	Written int      `json:"written"`
	Missing []string `json:"missing"`
	Failed  []string `json:"failed"`
}

// BroadcastWrite 把同一段输入写入多个会话（顺序遍历逐个 WriteInput）。
// id 去重：同一 id 重复出现只写一次（防调用方重复勾选造成重复执行）。
// 单会话失败不中断整批——舰队语义，个别掉队不拖累其余，结果逐类回告。
// 量级：会话总量受 MaxSessions 上限约束，每次 WriteInput 是一次进 PTY 缓冲的
// 内存写，整体 O(ids×len(data))，无热点。
// 锁序：GetSession 内 m.mu.RLock 即取即释，WriteInput 只持 s.mu——未在
// m.mu 与 s.mu 之间新增持锁跨接（handleAttachExit 注明的锁序反转环不受影响）
func (m *Manager) BroadcastWrite(ids []string, data []byte) BroadcastResult {
	res := BroadcastResult{Missing: []string{}, Failed: []string{}}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		s := m.GetSession(id)
		if s == nil {
			res.Missing = append(res.Missing, id)
			continue
		}
		if err := s.WriteInput(data); err != nil {
			res.Failed = append(res.Failed, id)
			continue
		}
		res.Written++
	}
	return res
}

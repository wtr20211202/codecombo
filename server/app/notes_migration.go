package app

import (
	"fmt"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// notesMigrationPendingNotification 笔记单库化迁移满额中止告知卡（P-20261108-3）：
// 启动期迁移因全局笔记库满额（100 篇含回收站）中止时入账一条——「零丢弃」的
// 用户知情面（日志对多数用户不可见）。warning/system；动作 panel:notes 直达
// 笔记视图（入站 Hook 白名单既有面板值，前端 useLayoutShell 接 openNotesView），
// 视图顶部续迁横幅给出「继续迁移」。模板键走前端 system.notesMigration.*，
// Title 明文是无模板消费方（webhook 外发、API 直读）的回退；Body 留空——
// 模板摘要已含滞留篇数，Body 非空会作为明细行追加在摘要之后
func notesMigrationPendingNotification(res store.NotesMigrationResult) notification.Notification {
	return notification.Notification{
		Type:          "warning",
		Category:      notification.CategorySystem,
		TitleKey:      "system.notesMigration.title",
		BodyKey:       "system.notesMigration.body",
		Title:         fmt.Sprintf("笔记库已满：%d 篇旧项目笔记尚未并入", res.Pending),
		Action:        "panel",
		ActionPayload: "notes",
		MsgParams:     map[string]any{"pending": res.Pending},
	}
}

package deploy

import "time"

// 日志级别
const (
	LevelInfo = "info"
	LevelOK   = "ok"
	LevelWarn = "warn"
	LevelFail = "fail"
)

// LogEntry 日志条目（推 WS）
type LogEntry struct {
	Time     time.Time    `json:"time"`
	Deployer string       `json:"deployer"`
	Step     string       `json:"step"`
	Level    string       `json:"level"`
	Message  string       `json:"message"`
	// MessageKey + MessageParams 用于前端 i18n：
	// 前端优先用 t(MessageKey, MessageParams) 翻译，无 key 时回退到 Message
	MessageKey    string         `json:"messageKey,omitempty"`
	MessageParams map[string]any `json:"messageParams,omitempty"`
}

// Logger 日志器接口（由 Manager 实现）
type Logger interface {
	Log(step, level, msg string)
	// LogKV 带国际化 key + params 的日志
	LogKV(step, level, key string, params map[string]any)
	SetPublicKey(keyName, pub string)
}

// noopLogger 不做任何事（测试用）
type noopLogger struct{}

func (noopLogger) Log(string, string, string)         {}
func (noopLogger) LogKV(string, string, string, map[string]any) {}
func (noopLogger) SetPublicKey(string, string)        {}

// NoopLogger 返回一个空操作的 Logger
func NoopLogger() Logger { return noopLogger{} }

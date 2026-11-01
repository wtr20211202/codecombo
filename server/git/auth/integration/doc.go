// Package integration 包含 simple-coding 认证链路的端到端集成测试
//
// 所有测试用例带 //go:build integration 标签，仅在以下命令运行：
//
//	go test -tags=integration ./server/git/auth/integration/ -v
//
// 默认 go test ./... 不扫描本目录的 *_test.go，避免编译二进制拖慢 CI。
// 本 doc.go 不带 build 标签，仅用于让默认 go build / go vet 把本包识别为合法空包
// （否则会因 "build constraints exclude all Go files" 报 setup failed）。
package integration

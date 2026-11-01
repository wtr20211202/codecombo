package mask

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

// 遮蔽器单测（安全修正硬性）：明文 token / 跨分片 token / OSC 133 E 帧 base64
// 命令文本 / 误伤防护（普通文本不得改写）。

// sampleToken 真实令牌形态（store/agenttoken.go：sca_ + 16 字节 hex，无连字符
// ——值段全为 [A-Za-z0-9]，任务书模式可整段遮蔽）
const sampleToken = "sca_8f3a2b1c4d5e4f6a8b7c9d0e1f2a3b4c"

func TestMasker_PlainToken(t *testing.T) {
	m := NewMasker()
	out := string(m.Write([]byte("export CC_LOCK_TOKEN=" + sampleToken + "\r\n")))
	if strings.Contains(out, sampleToken) {
		t.Fatalf("token leaked: %q", out)
	}
	if !strings.Contains(out, tokenMask) {
		t.Fatalf("mask missing: %q", out)
	}
	if !strings.Contains(out, "export CC_LOCK_TOKEN=") {
		t.Fatalf("non-sensitive prefix corrupted: %q", out)
	}
}

func TestMasker_TokenAcrossWrites(t *testing.T) {
	m := NewMasker()
	var out bytes.Buffer
	out.Write(m.Write([]byte("token=")))
	out.Write(m.Write([]byte("sc")))
	out.Write(m.Write([]byte("a_abc")))
	out.Write(m.Write([]byte("123 xyz")))
	out.Write(m.Flush())
	got := out.String()
	if strings.Contains(got, "sca_abc123") {
		t.Fatalf("split token leaked: %q", got)
	}
	if !strings.Contains(got, "token="+tokenMask+" xyz") {
		t.Fatalf("unexpected masked result: %q", got)
	}
}

// 逐字节喂入与整段写入结果一致（分片无关性）
func TestMasker_ByteByByteEqualsWhole(t *testing.T) {
	corpus := "prompt $ echo sca_abcdef123 sca_zz99 scale_1 scx_;tail sc_ap_1-2-3\r\n" +
		"\x1b]133;E;" + base64.StdEncoding.EncodeToString([]byte("curl -H 'X-Token: sca_deadbeef42' https://x")) + "\x07" +
		"done 中文输出保持原样 sca_last1"
	wm := NewMasker()
	whole := string(append(wm.Write([]byte(corpus)), wm.Flush()...))

	m := NewMasker()
	var out bytes.Buffer
	for i := 0; i < len(corpus); i++ {
		out.Write(m.Write([]byte{corpus[i]}))
	}
	out.Write(m.Flush())
	if out.String() != whole {
		t.Fatalf("byte-by-byte != whole:\n whole=%q\n bytes=%q", whole, out.String())
	}
	// 两侧共同语义抽查：明文 token 均不残留
	if strings.Contains(whole, "sca_abcdef123") || strings.Contains(out.String(), "sca_abcdef123") {
		t.Fatalf("corpus token leaked")
	}
}

func TestMasker_NoFalsePositive(t *testing.T) {
	cases := []string{
		"scale_value",         // sc + le_ → 非模式
		"scx_;",               // 值段缺位（sc?_ 后紧跟终结符）
		"sc_",                 // 第 3 位非小写字母
		"sc_a",                // 同上（下划线不在值段字母位）
		"CC_LOCK_TOKEN=plain", // 大写不命中
	}
	for _, c := range cases {
		m := NewMasker()
		out := string(append(m.Write([]byte(c)), m.Flush()...))
		if strings.Contains(out, tokenMask) {
			t.Fatalf("false positive on %q → %q", c, out)
		}
		if out != c {
			t.Fatalf("corrupted %q → %q", c, out)
		}
	}
}

func TestMasker_EFrameCommandMasked(t *testing.T) {
	cmd := "curl -H 'X-Token: sca_beefcafe11' https://api.example.com"
	frame := "\x1b]133;E;" + base64.StdEncoding.EncodeToString([]byte(cmd)) + "\x07"
	m := NewMasker()
	out := string(m.Write([]byte("before " + frame + " after")))
	if strings.Contains(out, "sca_beefcafe11") {
		t.Fatalf("token leaked via E frame: %q", out)
	}
	// 帧结构保持：遮蔽后命令重新 base64，头与终结符原样
	if !strings.Contains(out, "\x1b]133;E;") || !strings.HasSuffix(out, "\x07 after") {
		t.Fatalf("frame structure broken: %q", out)
	}
	// 解码回命令文本，非敏感部分保留
	i := strings.Index(out, "\x1b]133;E;") + len("\x1b]133;E;")
	j := strings.Index(out[i:], "\x07") + i
	decoded, err := base64.StdEncoding.DecodeString(out[i:j])
	if err != nil {
		t.Fatalf("re-encoded payload invalid: %v", err)
	}
	if want := "curl -H 'X-Token: " + tokenMask + "' https://api.example.com"; string(decoded) != want {
		t.Fatalf("decoded command = %q, want %q", decoded, want)
	}
}

func TestMasker_EFrameAcrossWrites(t *testing.T) {
	cmd := "deploy --token sca_split12345"
	payload := base64.StdEncoding.EncodeToString([]byte(cmd))
	frame := "\x1b]133;E;" + payload + "\x07"
	m := NewMasker()
	var out bytes.Buffer
	for i := 0; i < len(frame); i += 3 {
		end := i + 3
		if end > len(frame) {
			end = len(frame)
		}
		out.Write(m.Write([]byte(frame[i:end])))
	}
	out.Write(m.Flush())
	got := out.String()
	if strings.Contains(got, "sca_split12345") {
		t.Fatalf("split E frame token leaked: %q", got)
	}
	// 遮蔽结果在重编码的 base64 里：解码校验
	i := strings.Index(got, "\x1b]133;E;") + len("\x1b]133;E;")
	j := strings.Index(got[i:], "\x07") + i
	decoded, err := base64.StdEncoding.DecodeString(got[i:j])
	if err != nil {
		t.Fatalf("re-encoded payload invalid: %v", err)
	}
	if !strings.Contains(string(decoded), tokenMask) || strings.Contains(string(decoded), "sca_split12345") {
		t.Fatalf("decoded command not masked: %q", decoded)
	}
}

func TestMasker_EFrameInvalidBase64Passthrough(t *testing.T) {
	// 非 base64 载荷（帧损坏）：原样放行，不损坏证据
	frame := "\x1b]133;E;!!!not-base64!!!\x07"
	m := NewMasker()
	out := string(m.Write([]byte(frame)))
	if out != frame {
		t.Fatalf("invalid b64 frame must passthrough: %q", out)
	}
}

func TestMasker_LongValueOverMasked(t *testing.T) {
	m := NewMasker()
	out := string(m.Write([]byte("scx_" + strings.Repeat("A", 2000) + " tail")))
	if strings.Contains(out, strings.Repeat("A", 100)) {
		t.Fatalf("long value leaked: %q", out[:80])
	}
	if !strings.Contains(out, tokenMask) {
		t.Fatalf("mask missing: %q", out)
	}
}

func TestMasker_UTF8Passthrough(t *testing.T) {
	m := NewMasker()
	out := string(append(m.Write([]byte("中文输出·λ·🎉")), m.Flush()...))
	if out != "中文输出·λ·🎉" {
		t.Fatalf("utf-8 corrupted: %q", out)
	}
}

func TestMaskText(t *testing.T) {
	got := MaskText("git push sca_abc123 to origin")
	if got != "git push "+tokenMask+" to origin" {
		t.Fatalf("MaskText = %q", got)
	}
}

// ============== 模式集扩充（P-20261002-108）==============
// 与 web/src/utils/sensitiveMask.test.ts 同一 fixture 语料互锁：模式②赋值
// 形态 / 模式③云密钥 + 词边界 + 跨分片。流式侧额外的分片维度由本文件覆盖。

// 赋值形态（模式②）：键名+分隔符保留、值整段替换；大小写不敏感；shell
// KEY=value / YAML "key": "value" 引号形态（值必须与键构成 =/: 赋值关系——
// 空白分隔的 CLI 值形态不在模式集，误伤面不可控）
func TestMasker_AssignValueMasked(t *testing.T) {
	cases := []struct{ in, want string }{
		{"password=hunter2", "password=" + tokenMask},
		{"PASSWORD=hunter2", "PASSWORD=" + tokenMask},
		{"--token=abc123", "--token=" + tokenMask},
		{"db.password: p@ss w0rd", "db.password: " + tokenMask + " w0rd"},
		{`"token": "abc def"`, `"token": ` + tokenMask},
		{"token='abc def' done", "token=" + tokenMask + " done"},
		{"password = hunter2", "password = " + tokenMask},
		{"pwd=short", "pwd=" + tokenMask},
		{"passwd=x", "passwd=" + tokenMask},
		{"password=abc=def", "password=" + tokenMask},
	}
	for _, c := range cases {
		m := NewMasker()
		out := string(append(m.Write([]byte(c.in)), m.Flush()...))
		if out != c.want {
			t.Fatalf("assign %q → %q, want %q", c.in, out, c.want)
		}
	}
}

// 赋值形态键名+值跨 Write 分片：键名中断裂 / 值段中断裂均不漏
func TestMasker_AssignAcrossWrites(t *testing.T) {
	m := NewMasker()
	var out bytes.Buffer
	for _, part := range []string{"export pass", "word=sec", "ret123 done"} {
		out.Write(m.Write([]byte(part)))
	}
	out.Write(m.Flush())
	got := out.String()
	if !strings.Contains(got, "export password="+tokenMask+" done") || strings.Contains(got, "secret123") {
		t.Fatalf("split assign leaked: %q", got)
	}

	m = NewMasker()
	out.Reset()
	for _, part := range []string{"password=", "hu", "nter2 x"} {
		out.Write(m.Write([]byte(part)))
	}
	out.Write(m.Flush())
	if got = out.String(); got != "password="+tokenMask+" x" {
		t.Fatalf("split value → %q", got)
	}
}

// 赋值形态词边界（与全量 \b 同语义）：复合标识符内的键名片段不是赋值
func TestMasker_AssignKeyBoundary(t *testing.T) {
	cases := []string{
		"my_token=abc",            // 下划线复合词：_ 与 t 同为词字节，无边界
		"tokenizer=abc",           // 键名后非分隔符
		"passwords=abc",           // 同上（复数）
		"password policy: strict", // 键名后无分隔符
		"token=",                  // 空值不构成赋值
		"the password:",           // 冒号前空白后无值
	}
	for _, c := range cases {
		m := NewMasker()
		out := string(append(m.Write([]byte(c)), m.Flush()...))
		if out != c {
			t.Fatalf("boundary false positive %q → %q", c, out)
		}
	}
}

// 相邻赋值：前值终结符（空白）在原文上构成后一键名的词边界——与全量正则
// 同语义，两个赋值都遮蔽（prev 按原始流逐字节判定）
func TestMasker_AssignAdjacentBoundary(t *testing.T) {
	m := NewMasker()
	out := string(append(m.Write([]byte("password=hunter2 token=x")), m.Flush()...))
	if want := "password=" + tokenMask + " token=" + tokenMask; out != want {
		t.Fatalf("adjacent assign = %q, want %q", out, want)
	}
}

// SGR 紧贴键名（PSReadLine 着色回显 `\x1b[37mPASSWORD=`）：序列尾字节 'm'
// 是词字节，边界须透明化——序列完成后即视作边界（与全量「SGR 边界」同语义）
func TestMasker_SGRAdjacentBoundary(t *testing.T) {
	cases := []struct{ in, want string }{
		{"\x1b[93mecho \x1b[37mPASSWORD=hunter2", "\x1b[93mecho \x1b[37mPASSWORD=" + tokenMask},
		{"\x1b[?25l\x1b[37mtoken=sca_abc AKIAIOSFODNN7EXAMPLE", "\x1b[?25l\x1b[37mtoken=" + tokenMask + " " + tokenMask},
	}
	for _, c := range cases {
		m := NewMasker()
		out := string(append(m.Write([]byte(c.in)), m.Flush()...))
		if out != c.want {
			t.Fatalf("sgr-adjacent %q → %q, want %q", c.in, out, c.want)
		}
	}
	// SGR 序列跨 Write 分片：跟踪跨片持续，完成照常视作边界
	m := NewMasker()
	var out bytes.Buffer
	for _, part := range []string{"echo \x1b[3", "7mpassword=hu", "nter2 done"} {
		out.Write(m.Write([]byte(part)))
	}
	out.Write(m.Flush())
	if got := out.String(); got != "echo \x1b[3"+"7mpassword="+tokenMask+" done" {
		t.Fatalf("split SGR → %q", got)
	}
}

// 云密钥（模式③）：AKIA/ASIA + 16 位大写数字整段替换；长度/大小写/边界
// 不符不误伤；证伪候选逐字节原样还原（不损坏证据）
func TestMasker_CloudKeyMasked(t *testing.T) {
	cases := []struct{ in, want string }{
		{"AKIAIOSFODNN7EXAMPLE", tokenMask},
		{"key=ASIAIOSFODNN7EXAMPLE ok", "key=" + tokenMask + " ok"},
		{"AKIAIOSFODNN7EXAMPL", "AKIAIOSFODNN7EXAMPL"},     // 19 位：长度不足
		{"AKIAIOSFODNN7EXAMPLEX", "AKIAIOSFODNN7EXAMPLEX"}, // 21 位：超长非密钥
		{"akiaiosfodnn7example", "akiaiosfodnn7example"},   // 小写非 AWS 密钥形态
		{"xAKIAIOSFODNN7EXAMPLE", "xAKIAIOSFODNN7EXAMPLE"}, // 前贴词字节：无边界
		{"AKIA-IOSFODNN7EXAM", "AKIA-IOSFODNN7EXAM"},       // 值段断裂非密钥
	}
	for _, c := range cases {
		m := NewMasker()
		out := string(append(m.Write([]byte(c.in)), m.Flush()...))
		if out != c.want {
			t.Fatalf("cloud key %q → %q, want %q", c.in, out, c.want)
		}
	}
}

// 云密钥跨 Write 分片：前缀/值段/边界任意处断裂均不漏、不损坏
func TestMasker_CloudKeyAcrossWrites(t *testing.T) {
	m := NewMasker()
	var out bytes.Buffer
	for _, part := range []string{"aws_access_key_id=AKIA", "IOSFODNN7EXAM", "PLE next"} {
		out.Write(m.Write([]byte(part)))
	}
	out.Write(m.Flush())
	if got := out.String(); got != "aws_access_key_id="+tokenMask+" next" {
		t.Fatalf("split cloud key → %q", got)
	}
	// 流尾恰为 20 位密钥：Flush 按流尾边界补出
	m = NewMasker()
	out.Reset()
	out.Write(m.Write([]byte("AKIAIOSFODNN7EXAM")))
	out.Write(m.Write([]byte("PLE")))
	out.Write(m.Flush())
	if got := out.String(); got != tokenMask {
		t.Fatalf("tail cloud key → %q", got)
	}
}

// 流尾滞留的赋值/云密钥值由 Flush 补出 ***（值在流尾即完整命中，全量语义一致）
func TestMasker_AssignValueAtStreamEnd(t *testing.T) {
	m := NewMasker()
	out := string(append(m.Write([]byte("password=hunter2")), m.Flush()...))
	if out != "password="+tokenMask {
		t.Fatalf("EOF value → %q", out)
	}
	// 引号值流尾未闭合：已有值字符 → 宁遮不还原（安全方向）
	m = NewMasker()
	out = string(append(m.Write([]byte(`password="hunter2`)), m.Flush()...))
	if out != "password="+tokenMask {
		t.Fatalf("EOF quoted value → %q", out)
	}
	// 仅开引号无值字符：全量侧不构成命中 → 原样还原
	m = NewMasker()
	out = string(append(m.Write([]byte("password='")), m.Flush()...))
	if out != "password='" {
		t.Fatalf("EOF empty quote → %q", out)
	}
}

// E 帧载荷里的新模式（命令文本 password=/AKIA 赋值形态）经解码全量遮蔽
func TestMasker_EFrameNewPatterns(t *testing.T) {
	cmd := "deploy --password=hunter2 --key AKIAIOSFODNN7EXAMPLE"
	frame := "\x1b]133;E;" + base64.StdEncoding.EncodeToString([]byte(cmd)) + "\x07"
	m := NewMasker()
	out := string(m.Write([]byte(frame)))
	i := strings.Index(out, "\x1b]133;E;") + len("\x1b]133;E;")
	j := strings.Index(out[i:], "\x07") + i
	decoded, err := base64.StdEncoding.DecodeString(out[i:j])
	if err != nil {
		t.Fatalf("re-encoded payload invalid: %v", err)
	}
	want := "deploy --password=" + tokenMask + " --key " + tokenMask
	if string(decoded) != want {
		t.Fatalf("decoded command = %q, want %q", decoded, want)
	}
}

// 全量 MaskText 覆盖新模式（E 帧解码载荷 / 元数据展示同款）
func TestMaskText_ExpandedPatterns(t *testing.T) {
	got := MaskText("password=hunter2 scl_locktok AKIAIOSFODNN7EXAMPLE plain")
	want := "password=" + tokenMask + " " + tokenMask + " " + tokenMask + " plain"
	if got != want {
		t.Fatalf("MaskText = %q, want %q", got, want)
	}
	// 不误伤普通文本
	plain := "scale_1 tokenizer=1 passwords policy my_token=x"
	if got := MaskText(plain); got != plain {
		t.Fatalf("MaskText false positive = %q", got)
	}
	// SGR 紧贴键名（着色回显）：序列保真、值遮蔽
	if got := MaskText("\x1b[37mPASSWORD=hunter2"); got != "\x1b[37mPASSWORD="+tokenMask {
		t.Fatalf("MaskText SGR-adjacent = %q", got)
	}
}

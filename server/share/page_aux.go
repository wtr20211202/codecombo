package share

import (
	"html/template"
	"io"
	"strconv"
	"strings"
)

// 分享访客页辅助页（P-20261007-22 纯搬运自 page.go，零逻辑改动）：
// 404/410 品牌 404 壳（notFound/expired/consumed 三态复用）、一次性分享
// 确认页与访问口令页——均零 JS 纯 HTML 表单/静态壳

const notFoundTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">
<title>{{.Code}} · Codecombo</title>
<style>
:root{--bg:#f4f6fb;--card:#ffffff;--text:#1b2437;--muted:#667085;--border:#e6e9f0;--accent:#3d7bfd;--accent2:#6a5cff;--shadow:0 18px 50px rgba(23,43,99,.12)}
@media (prefers-color-scheme: dark){:root{--bg:#0e1320;--card:#161d2f;--text:#e6eaf3;--muted:#8b94a9;--border:#263149;--shadow:0 18px 50px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);overflow:hidden;
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0}
.b1{width:380px;height:380px;background:rgba(106,92,255,.30);top:-90px;right:-70px}
.b2{width:320px;height:320px;background:rgba(61,123,253,.26);bottom:-90px;left:-60px}
.center{position:relative;z-index:1;height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.nf{max-width:560px;width:100%;background:var(--card);border:1px solid var(--border);
border-radius:22px;box-shadow:var(--shadow);padding:52px 48px 40px;text-align:center}
.brand{display:inline-flex;align-items:center;gap:10px;margin-bottom:30px}
.brand .mark{width:44px;height:44px;border-radius:13px;display:flex;align-items:center;justify-content:center;
background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 18px rgba(61,123,253,.35)}
.brand .name{font-size:16px;font-weight:650;color:var(--text);letter-spacing:.2px}
.code{font-size:72px;line-height:1;font-weight:750;letter-spacing:2px;
background:linear-gradient(135deg,var(--accent),var(--accent2));
-webkit-background-clip:text;background-clip:text;color:transparent;margin:18px 0 14px}
.title{font-size:17px;font-weight:600;color:var(--text);margin:6px 0 10px}
.desc{color:var(--muted);margin:0 0 26px;font-size:13.5px}
.hint{display:inline-flex;align-items:center;gap:8px;background:var(--chip);
border:1px solid var(--border);border-radius:12px;padding:10px 16px;font-size:12.5px;color:var(--muted)}
.ft{margin-top:30px;color:var(--muted);font-size:12px;opacity:.8}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div class="center">
  <div class="nf">
    <div class="brand">
      <span class="mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z"/><path d="M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z"/><path d="M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0"/><path d="M12 15v5s3.4-.5 4.5-2c1.2-1.7 0-5 0-5"/></svg></span>
      <span class="name">Codecombo</span>
    </div>
    <div class="code">{{.Code}}</div>
    <div class="title">{{.Title}}</div>
    <p class="desc">{{.Message}}</p>
    <div class="hint">{{.Hint}}</div>
    <div class="ft">{{.Footer}}</div>
  </div>
</div>
</body>
</html>`

var notFoundTmpl = template.Must(template.New("nf").Parse(notFoundTmplSrc))

// renderNotFoundPage 未知/已取消短链的品牌 404 页
func renderNotFoundPage(w io.Writer, lang string) error {
	d := dictFor(lang)
	return notFoundTmpl.Execute(w, struct {
		Lang    string
		Code    string
		Title   string
		Message string
		Hint    string
		Footer  string
	}{Lang: lang, Code: "404", Title: d["notFoundHeading"], Message: d["notFoundDesc"], Hint: d["notFoundHint"], Footer: d["poweredBy"]})
}

// renderExpiredPage 已过保留窗口短链的品牌 410 页（明确「已过期」文案）
func renderExpiredPage(w io.Writer, lang string) error {
	d := dictFor(lang)
	return notFoundTmpl.Execute(w, struct {
		Lang    string
		Code    string
		Title   string
		Message string
		Hint    string
		Footer  string
	}{Lang: lang, Code: "410", Title: d["expiredHeading"], Message: d["expiredDesc"], Hint: d["expiredHint"], Footer: d["poweredBy"]})
}

// renderConsumedPage 一次性分享已被查看且宽限窗走完的品牌 410 页
// （P-20261006-27：文案「已被查看并失效」，与 TTL「已过期」语境区分——
// 复用 404/410 品牌壳，仅标题/描述/提示换键）
func renderConsumedPage(w io.Writer, lang string) error {
	d := dictFor(lang)
	return notFoundTmpl.Execute(w, struct {
		Lang    string
		Code    string
		Title   string
		Message string
		Hint    string
		Footer  string
	}{Lang: lang, Code: "410", Title: d["consumedHeading"], Message: d["consumedDesc"], Hint: d["consumedHint"], Footer: d["poweredBy"]})
}

// 一次性分享确认页（P-20261020-3）：泛化标题/描述 + 单一提交钮，零外部
// 依赖零 JS。刻意不接收分享记录字段——文件名/项目名没有任何进入本模板的
// 路径（确认页会先于收件人被 IM/邮件预览抓取命中）。与 404/410 品牌壳
// 不同，本页有必达的主操作钮：内容超高（小屏/字体放大）时允许滚动——锁
// overflow 会把「查看内容」裁到视口外，访客再无入口
const confirmTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<title>Codecombo · {{.Heading}}</title>
<style>
:root{--bg:#f4f6fb;--card:#ffffff;--text:#1b2437;--muted:#667085;--border:#e6e9f0;--accent:#3d7bfd;--accent2:#6a5cff;--err:#d64545;--chip:#eef2ff;--shadow:0 18px 50px rgba(23,43,99,.12)}
@media (prefers-color-scheme: dark){:root{--bg:#0e1320;--card:#161d2f;--text:#e6eaf3;--muted:#8b94a9;--border:#263149;--err:#e07a7a;--shadow:0 18px 50px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--text);overflow:auto;
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0}
.b1{width:380px;height:380px;background:rgba(106,92,255,.30);top:-90px;right:-70px}
.b2{width:320px;height:320px;background:rgba(61,123,253,.26);bottom:-90px;left:-60px}
.center{position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.nf{max-width:460px;width:100%;background:var(--card);border:1px solid var(--border);
border-radius:22px;box-shadow:var(--shadow);padding:44px 40px 36px;text-align:center}
.mark{width:52px;height:52px;border-radius:15px;display:inline-flex;align-items:center;justify-content:center;
background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 18px rgba(61,123,253,.35);margin-bottom:18px}
.title{font-size:17px;font-weight:650;margin:0 0 6px}
.desc{color:var(--muted);margin:0 0 12px;font-size:13px}
.hint{display:inline-block;background:var(--chip);border:1px solid var(--border);border-radius:10px;
padding:8px 14px;font-size:12.5px;color:var(--muted);margin:0 0 20px}
.err{color:var(--err);font-size:12.5px;margin:0 0 12px;word-break:break-word}
.btn{border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
padding:10px 30px;border-radius:10px;font-size:14px;cursor:pointer}
.btn:hover{filter:brightness(1.08)}
.ft{margin-top:26px;color:var(--muted);font-size:12px;opacity:.8}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div class="center">
  <div class="nf">
    <span class="mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg></span>
    <h1 class="title">{{.Heading}}</h1>
    <p class="desc">{{.Desc}}</p>
    <div class="hint">{{.Hint}}</div>
    {{if .Err}}<p class="err">{{.Err}}</p>{{end}}
    <form method="post" action="/s/{{.Token}}/view">
      <button class="btn" type="submit">{{.Submit}}</button>
    </form>
    <div class="ft">{{.Footer}}</div>
  </div>
</div>
</body>
</html>`

var confirmTmpl = template.Must(template.New("confirm").Parse(confirmTmplSrc))

// renderConfirmPage 一次性分享确认页（P-20261020-3）：纯 HTML 表单零 JS
// （CSP form-action 'self' 由 writeConfirm 施加）。文案刻意泛化——不接收
// 分享记录字段，文件名/项目名没有进入本模板的路径；minutes 取自宽限窗
// 常量（单一事实源 store.ViewOnceGrace），limited 选限流错误文案。
func renderConfirmPage(w io.Writer, token, lang string, minutes int, limited bool) error {
	d := dictFor(lang)
	errMsg := ""
	if limited {
		errMsg = d["confirmLimited"]
	}
	return confirmTmpl.Execute(w, struct {
		Lang, Token, Heading, Desc, Hint, Err, Submit, Footer string
	}{
		Lang:    lang,
		Token:   token,
		Heading: d["confirmHeading"],
		Desc:    strings.ReplaceAll(d["confirmDesc"], "{minutes}", strconv.Itoa(minutes)),
		Hint:    d["confirmHint"],
		Err:     errMsg,
		Submit:  d["confirmSubmit"],
		Footer:  d["poweredBy"],
	})
}

const gateTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">
<title>Codecombo · {{.Heading}}</title>
<style>
:root{--bg:#f4f6fb;--card:#ffffff;--text:#1b2437;--muted:#667085;--border:#e6e9f0;--accent:#3d7bfd;--accent2:#6a5cff;--err:#d64545;--chip:#eef2ff;--shadow:0 18px 50px rgba(23,43,99,.12)}
@media (prefers-color-scheme: dark){:root{--bg:#0e1320;--card:#161d2f;--text:#e6eaf3;--muted:#8b94a9;--border:#263149;--err:#e07a7a;--shadow:0 18px 50px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);overflow:hidden;
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0}
.b1{width:380px;height:380px;background:rgba(106,92,255,.30);top:-90px;right:-70px}
.b2{width:320px;height:320px;background:rgba(61,123,253,.26);bottom:-90px;left:-60px}
.center{position:relative;z-index:1;height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.nf{max-width:460px;width:100%;background:var(--card);border:1px solid var(--border);
border-radius:22px;box-shadow:var(--shadow);padding:44px 40px 36px;text-align:center}
.mark{width:52px;height:52px;border-radius:15px;display:inline-flex;align-items:center;justify-content:center;
background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 6px 18px rgba(61,123,253,.35);margin-bottom:18px}
.title{font-size:17px;font-weight:650;margin:0 0 6px}
.desc{color:var(--muted);margin:0 0 22px;font-size:13px}
.err{color:var(--err);font-size:12.5px;margin:0 0 12px;word-break:break-word}
.field{display:flex;gap:8px}
.field input{flex:1;min-width:0;border:1px solid var(--border);border-radius:10px;background:transparent;
color:var(--text);padding:10px 14px;font-size:14px;outline:none}
.field input:focus{border-color:var(--accent)}
.field button{flex:0 0 auto;border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));
color:#fff;padding:10px 22px;border-radius:10px;font-size:13.5px;cursor:pointer}
.field button:hover{filter:brightness(1.08)}
.ft{margin-top:26px;color:var(--muted);font-size:12px;opacity:.8}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div class="center">
  <div class="nf">
    <span class="mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.5" r="1.4" fill="#fff" stroke="none"/></svg></span>
    <h1 class="title">{{.Heading}}</h1>
    <p class="desc">{{.Desc}}</p>
    {{if .Err}}<p class="err">{{.Err}}</p>{{end}}
    <form method="post" action="/s/{{.Token}}/gate">
      <div class="field">
        <input type="password" name="passphrase" placeholder="{{.Placeholder}}" autocomplete="off" autofocus required>
        <button type="submit">{{.Submit}}</button>
      </div>
    </form>
    <div class="ft">{{.Footer}}</div>
  </div>
</div>
</body>
</html>`

var gateTmpl = template.Must(template.New("gate").Parse(gateTmplSrc))

// renderGatePage 访问口令页（P-20261006-25）：纯 HTML 表单零 JS（CSP 锁死
// form-action 'self' 由 writeGate 施加），errCode 选错误文案（""=首次进入）。
// token 只进 action 路径（base36 形态门禁后的值，无注入面）；输入值不回填
// ——错口令后清空重输比回填已证伪的值更安全也更省心
func renderGatePage(w io.Writer, token, lang, errCode string) error {
	d := dictFor(lang)
	errMsg := ""
	switch errCode {
	case gateErrWrong:
		errMsg = d["gateError"]
	case gateErrLimited:
		errMsg = d["gateLimited"]
	}
	return gateTmpl.Execute(w, struct {
		Lang, Token, Heading, Desc, Err, Placeholder, Submit, Footer string
	}{
		Lang:        lang,
		Token:       token,
		Heading:     d["gateHeading"],
		Desc:        d["gateDesc"],
		Err:         errMsg,
		Placeholder: d["gatePlaceholder"],
		Submit:      d["gateSubmit"],
		Footer:      d["poweredBy"],
	})
}

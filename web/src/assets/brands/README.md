# 品牌图标资产（vendored）

| 文件 | 品牌 | 来源 |
| --- | --- | --- |
| `claude.svg` | Claude（Anthropic） | Simple Icons 官方品牌标路径数据 |
| `dsh.svg` | DeepSeek | Simple Icons 官方品牌标路径数据 |
| `custom.svg` | （自绘通用兜底） | 本项目自绘（终端形状，currentColor） |

## 许可

- 路径数据取自 [Simple Icons](https://github.com/simple-icons/simple-icons)（仓库代码
  CC0-1.0；升级/新增品牌时从其官方源取最新路径数据，保持 `viewBox 0 0 24 24` 原样）。
- **商标注记**：Claude / DeepSeek 等品牌图形是各自权利方的注册商标，本仓库不持有
  相关权利；此处仅作运行时身份识别（nominative use，参考 VS Code 扩展图标惯例），
  不构成品牌背书，也不得移作产品自身主标识使用。

## 消费方

`web/src/components/common/BrandIcon.vue`（`?raw` 内联渲染，保留品牌色 fill）。
新增品牌 = 本目录放官方 SVG + `BrandIcon.vue` 的 `BRANDS` 注册表登记一行。

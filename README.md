# DeepSeek 双语翻译

使用你自己的 DeepSeek API Key 的 Chrome 翻译扩展：网页双语对照、划词翻译、输入框翻译、站点规则。

## 安装

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录。
3. 在自动打开的设置页填入 DeepSeek API Key（在 https://platform.deepseek.com/api_keys 创建），点「测试连接」。

## 使用

| 功能 | 操作 |
|---|---|
| 整页双语对照 | 点击扩展图标 →「翻译本页」，或按 `Alt+A`；再次触发切换显示原文 |
| 划词翻译 | 选中文字后点击出现的「译」图标；或右键 →「DeepSeek 翻译选中内容」 |
| 输入框翻译 | 在输入框中 500ms 内连按三次空格，内容替换为设置的目标语言（默认英文） |
| 站点规则 | 扩展弹窗中设置「总是翻译本站 / 永不翻译本站」，或在设置页批量编辑 |

## 隐私

API Key 仅保存在本机 `chrome.storage.local`，翻译请求只由扩展后台直接发往你配置的 Base URL（默认 `https://api.deepseek.com`）。

## 开发

无构建步骤。修改代码后在 `chrome://extensions` 点刷新即可。

```bash
npm test        # 运行 lib/ 单元测试（Node 22+，无依赖）
npm run icons   # 重新生成图标
```

content scripts 的浏览器测试：用假的 `chrome.*` 在普通网页里加载 content scripts。

```bash
python -m http.server 4123 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:4123/tests/browser/harness.html 手动试用
# 自动场景（结果写在页面底部）：
chrome --headless=new --virtual-time-budget=20000 --dump-dom "http://127.0.0.1:4123/tests/browser/harness.html?autotest"
```

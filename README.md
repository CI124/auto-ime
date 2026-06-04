# Auto IME

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/items?itemName=auto-ime)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **[English](#english)** | 中文

一个智能输入法自动切换扩展，支持 **Linux** 和 **Windows**。基于 Tree-sitter AST 解析，根据代码上下文智能切换中/英文输入法。同时支持 **VSCodeVim 用户**和**普通编辑器用户**。

## 功能特性

- **双模式支持**：自动检测 VSCodeVim 扩展，Vim 用户和普通用户均可使用
- **智能上下文检测**：光标在注释中时自动切换到中文输入法，字符串中不干预
- **即时响应**：基于文本的快速注释检测，输入 `//`、`#` 等注释语法时立即切换
- **ESC 强制切换**：Vim 模式下按 ESC 退回 Normal 模式时强制切换到英文输入法
- **状态栏显示**：右下角状态栏实时显示当前输入法状态，支持点击切换
- **多语言支持**：JavaScript、TypeScript、Python、Go、Rust、C、C++、CSS、HTML、Lua、Java、Kotlin、Bash
- **高性能**：Tree-sitter WASM 增量解析 + 同步文本快速检测 + 动态防抖响应
- **模块化架构**：平台无关的核心逻辑 + 平台特定的适配器，易于扩展

## 支持的语言和注释类型

| 语言 | 单行注释 | 块注释 | 字符串 | 模板字符串 |
|------|----------|--------|--------|------------|
| JavaScript | `//` | `/* */` | `" '` | `` ` `` |
| TypeScript | `//` | `/* */` | `" '` | `` ` `` |
| Python | `#` | `""" '''` | `" '` | - |
| Go | `//` | `/* */` | `"` | `` ` `` |
| Rust | `//` `///` | `/* */` | `"` | `r#"..."#` |
| C | `//` | `/* */` | `"` | - |
| C++ | `//` `///` | `/* */` | `"` | `R"(...)"` |
| CSS | - | `/* */` | - | - |
| HTML | `<!-- -->` | - | - | - |
| Lua | `--` | `--[[ ]]` | `" '` | - |
| Java | `//` | `/* */` | `"` | - |
| Kotlin | `//` | `/* */` | `"` | - |
| Bash | `#` | - | `" '` | - |

## 安装

### 方式一：VS Code Marketplace

1. 打开 VS Code
2. 按 `Ctrl+Shift+X` 打开扩展面板
3. 搜索 `Auto IME`
4. 点击 **Install** 安装

```bash
code --install-extension CI124.auto-ime
```

### 方式二：手动安装（.vsix）

从 [GitHub Releases](https://github.com/CI124/auto-ime/releases) 下载 `.vsix` 文件：

```bash
code --install-extension auto-ime-0.6.0.vsix
```

## 使用方法

1. 安装后扩展会自动激活
2. 右下角状态栏显示当前输入法状态（`EN` 或 `中`）
3. 点击状态栏可手动切换

### Vim 模式

- Insert 模式下：光标在注释中 → 自动切中文；在代码中 → 自动切英文
- 按 `ESC` → 强制切英文
- 支持 `i`、`I`、`s`、`c` 等命令自动检测

### 普通模式

- 全局分析，无需进入特定模式
- 输入 `//`、`#` 等注释语法时自动切换

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `auto-ime.ibus.englishEngine` | `xkb:us::eng` | IBus 英文引擎 |
| `auto-ime.ibus.chineseEngine` | `libpinyin` | IBus 中文引擎 |
| `auto-ime.windows.pollingInterval` | `150` | Windows 轮询间隔（ms） |

## 支持的输入法框架

| 平台 | 框架 | 说明 |
|------|------|------|
| Linux | **Fcitx5**（推荐） | 自动读取 profile |
| Linux | **Fcitx4** | `fcitx-remote` 命令 |
| Linux | **IBus** | `ibus engine` 命令 |
| Windows | **双键盘** | 英语(1033) ↔ 拼音(2052)，需安装英语键盘 |
| Windows | **TSF 管道**（实验性） | 单键盘内中英切换 |

## 工作原理

1. **事件监听**：模式监听器（Normal/Vim）监听光标和文档变化
2. **快速路径**：同步文本检测行注释和块注释
3. **AST 解析**：Tree-sitter 增量解析，判断光标在注释/字符串/代码中
4. **切换决策**：只在注释中切换中文，字符串不干预
5. **平台切换**：适配器执行实际切换（Linux: shell 命令，Windows: 键盘布局）
6. **状态栏更新**：乐观更新显示

## 开发

```bash
npm install          # 安装依赖
npm run watch        # 监听模式
# 按 F5 启动调试
```

### 测试

```bash
node test/mock-koffi-test.js      # Windows (39 用例)
node test/mock-linux-ime-test.js  # Linux (70 用例)
node test/ast-analyzer-test.js    # AST (59 用例)
```

## 常见问题

**扩展不工作**：查看 "Auto IME" 输出面板日志。Windows 需安装英语(美国)键盘。

**输入法没切换**：Linux 确认 Fcitx5/IBus 正在运行。Windows 查看日志确认切换方法。

**性能问题**：动态防抖（10-60ms）+ 增量解析（3x 提速）+ 快速路径检测。

## 许可证

MIT License

---

<a id="english"></a>

# Auto IME (English)

An intelligent input method auto-switching extension for **Linux** and **Windows**. Based on Tree-sitter AST parsing, it automatically switches between Chinese and English input methods based on code context. Supports both **VSCodeVim users** and **regular editor users**.

## Features

- **Dual mode support**: Auto-detects VSCodeVim extension, works for both Vim and regular users
- **Smart context detection**: Auto-switches to Chinese in comments, leaves strings unchanged
- **Instant response**: Text-based fast comment detection, immediate switch on `//`, `#` etc.
- **ESC force switch**: Vim ESC forces English input in Normal mode
- **Status bar**: Bottom-right status bar shows current IME state, click to toggle
- **Multi-language**: JavaScript, TypeScript, Python, Go, Rust, C, C++, CSS, HTML, Lua, Java, Kotlin, Bash
- **High performance**: Tree-sitter WASM incremental parsing + synchronous fast detection + dynamic debounce
- **Modular architecture**: Platform-agnostic core + platform-specific adapters

## Supported Languages

| Language | Line Comment | Block Comment | String | Template String |
|----------|-------------|---------------|--------|-----------------|
| JavaScript | `//` | `/* */` | `" '` | `` ` `` |
| TypeScript | `//` | `/* */` | `" '` | `` ` `` |
| Python | `#` | `""" '''` | `" '` | - |
| Go | `//` | `/* */` | `"` | `` ` `` |
| Rust | `//` `///` | `/* */` | `"` | `r#"..."#` |
| C/C++ | `//` | `/* */` | `"` | - |
| HTML | `<!-- -->` | - | - | - |
| Lua | `--` | `--[[ ]]` | `" '` | - |
| Java/Kotlin | `//` | `/* */` | `"` | - |
| Bash | `#` | - | `" '` | - |

## Installation

### VS Code Marketplace

```bash
code --install-extension CI124.auto-ime
```

### Manual (.vsix)

Download from [GitHub Releases](https://github.com/CI124/auto-ime/releases):

```bash
code --install-extension auto-ime-0.6.0.vsix
```

## Usage

1. Extension activates automatically after install
2. Status bar (bottom-right) shows current IME state (`EN` or `中`)
3. Click status bar to manually toggle

### Vim Mode

- In Insert mode: cursor in comment → Chinese; in code → English
- Press `ESC` → force English
- Supports `i`, `I`, `s`, `c` commands auto-detection

### Normal Mode

- Global analysis, no specific mode needed
- Auto-switches on `//`, `#` comment syntax

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `auto-ime.ibus.englishEngine` | `xkb:us::eng` | IBus English engine |
| `auto-ime.ibus.chineseEngine` | `libpinyin` | IBus Chinese engine |
| `auto-ime.windows.pollingInterval` | `150` | Windows polling interval (ms) |

## Supported IME Frameworks

| Platform | Framework | Description |
|----------|-----------|-------------|
| Linux | **Fcitx5** (recommended) | Auto-reads profile |
| Linux | **Fcitx4** | `fcitx-remote` command |
| Linux | **IBus** | `ibus engine` command |
| Windows | **Dual keyboard** | English(1033) ↔ Pinyin(2052), requires English keyboard |
| Windows | **TSF pipe** (experimental) | Single keyboard Chinese/English toggle |

## How It Works

1. **Event listening**: Mode listeners (Normal/Vim) monitor cursor and document changes
2. **Fast path**: Synchronous text detection for line/block comments
3. **AST parsing**: Tree-sitter incremental parsing, determines comment/string/code context
4. **Switch decision**: Only switches to Chinese in comments, strings unchanged
5. **Platform switch**: Adapter executes actual switch (Linux: shell commands, Windows: keyboard layout)
6. **Status bar**: Optimistic display update

## Development

```bash
npm install          # Install dependencies
npm run watch        # Watch mode
# Press F5 to debug
```

### Tests

```bash
node test/mock-koffi-test.js      # Windows (39 cases)
node test/mock-linux-ime-test.js  # Linux (70 cases)
node test/ast-analyzer-test.js    # AST (59 cases)
```

## FAQ

**Extension not working**: Check "Auto IME" output panel. Windows requires English(US) keyboard.

**IME not switching**: Linux: verify Fcitx5/IBus is running. Windows: check log for switch method.

**Performance**: Dynamic debounce (10-60ms) + incremental parsing (3x faster) + fast path detection.

## License

MIT License

## Acknowledgments

- [Tree-sitter](https://tree-sitter.github.io/) — Code parsing library
- [VSCodeVim](https://github.com/VSCodeVim/Vim) — Vim emulator
- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) — Tree-sitter WASM bindings

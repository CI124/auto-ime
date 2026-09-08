# Auto IME

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/items?itemName=auto-ime)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> [English](README_EN.md) | **中文**

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

```bash
code --install-extension CI124.auto-ime
```

### 方式二：手动安装（.vsix）

从 [GitHub Releases](https://github.com/CI124/auto-ime/releases) 下载 `.vsix` 文件：

```bash
code --install-extension auto-ime-0.8.1.vsix
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
| `auto-ime.windows.strategy` | `auto` | Windows 切换策略：`auto`（默认，有英语键盘走双键盘，否则走单键盘热键）/ `dual-keyboard`（强制键盘布局切换）/ `single-keyboard`（强制单键盘内中英切换） |
| `auto-ime.windows.toggleKey` | `shift` | 单键盘切换热键：`shift`（微软拼音 Win11 默认）/ `ctrl-space`，需与输入法自身设置一致 |

## 支持的输入法框架

| 平台 | 框架 | 说明 |
|------|------|------|
| Linux | **Fcitx5**（推荐） | 自适应轮询 + profile 自动读取 |
| Linux | **IBus** | 自适应轮询 + 引擎配置 |
| Windows | **双键盘**（默认） | 英语(1033) ↔ 拼音(2052)，需安装英语键盘 |
| Windows | **单键盘热键** | 只装中文键盘时，模拟输入法切换热键在输入法内部切换中/英 |

**Windows 单键盘适用条件**

- 系统只装了中文输入法（如微软拼音），没有英语(1033) 键盘布局时自动启用
- 切换通过模拟输入法自己的切换热键实现（默认 `Shift`，可改为 `Ctrl+Space`），
  热键须与输入法设置一致（微软拼音 Win11 默认 Shift 切换中英文）
- 想强制使用（即使已装英语键盘），把 `auto-ime.windows.strategy` 设为 `single-keyboard`
- **限制**：TSF-only 应用无法跨进程读取输入法真实状态，扩展只能内部跟踪目标状态；
  用鼠标/系统托盘手动切换会造成状态漂移，此时可用 `Ctrl+Shift+Space`（`auto-ime.toggleIME`）校正

## 工作原理

1. **事件监听**：模式监听器（Normal/Vim）监听光标和文档变化
2. **快速路径**：同步文本检测行注释和块注释
3. **AST 解析**：Tree-sitter 增量解析，判断光标在注释/字符串/代码中
4. **切换决策**：只在注释中切换中文，字符串不干预
5. **平台切换**：适配器执行实际切换（Linux: shell 命令，Windows: 键盘布局或 IME 热键）
6. **外部切换检测**：Linux 通过自适应轮询检测（100-500ms）；Windows 单键盘模式无跨进程读取，靠内部状态跟踪
7. **状态栏更新**：乐观更新显示

## 开发

```bash
npm install          # 安装依赖
npm run watch        # 监听模式
# 按 F5 启动调试
```

### 测试

```bash
node test/mock-koffi-test.js      # Windows (33 用例)
node test/mock-tsf-test.js        # Windows 单键盘 (16 用例)
node test/mock-linux-ime-test.js  # Linux (56 用例)
node test/ast-analyzer-test.js    # AST (59 用例)
```

## 常见问题

**扩展不工作**：查看 "Auto IME" 输出面板日志。Windows 双键盘模式需安装英语(美国)键盘；
单键盘模式确认系统装有中文输入法。

**输入法没切换**：Linux 确认 Fcitx5/IBus 正在运行。Windows 单键盘模式确认
`auto-ime.windows.toggleKey` 与输入法自身的切换热键一致（微软拼音默认 Shift）。

**性能问题**：动态防抖（10-60ms）+ 增量解析（3x 提速）+ 快速路径检测。

## 许可证

MIT License

## 致谢

- [Tree-sitter](https://tree-sitter.github.io/) — 代码解析库
- [VSCodeVim](https://github.com/VSCodeVim/Vim) — Vim 模拟器
- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) — Tree-sitter WASM 绑定

# Auto Vim IME

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/items?itemName=auto-vim-ime)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个为 Linux 上的 VSCodeVim 用户设计的输入法自动切换扩展。基于 Tree-sitter AST 解析，根据代码上下文智能切换中/英文输入法。

## 功能特性

- **智能上下文检测**：光标在注释或字符串中时自动切换到中文输入法
- **即时响应**：基于文本的快速注释检测，输入 `//`、`#` 等注释语法时立即切换
- **ESC 强制切换**：按 ESC 退回 Normal 模式时强制切换到英文输入法
- **状态栏显示**：底部状态栏实时显示当前输入法状态，支持点击切换
- **多语言支持**：JavaScript、TypeScript、Python、Go、Rust、C、C++、CSS
- **高性能**：Tree-sitter WASM 解析 + 同步文本快速检测，30ms 防抖响应

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

## 安装

### 从 VS Code Marketplace 安装

1. 打开 VS Code
2. 按 `Ctrl+P` 打开命令面板
3. 输入 `ext install auto-vim-ime`

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/your-username/auto-vim-ime.git
cd auto-vim-ime

# 安装依赖（自动下载 WASM 文件）
npm install

# 编译
npm run compile

# 按 F5 启动调试
```

## 使用方法

1. 安装扩展后，扩展会自动激活
2. 底部状态栏会显示当前输入法状态（`EN` 或 `中`）
3. 在 Insert 模式下：
   - 光标移动到注释或字符串中 → 自动切换到中文
   - 光标移动到代码区域 → 自动切换到英文
4. 按 `ESC` 退回 Normal 模式 → 强制切换到英文
5. 点击状态栏可手动切换输入法

## 配置

在 VS Code 设置中搜索 `auto-vim-ime`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `auto-vim-ime.ibus.englishEngine` | `xkb:us::eng` | IBus 英文引擎名称 |
| `auto-vim-ime.ibus.chineseEngine` | `libpinyin` | IBus 中文引擎名称 |

## 支持的输入法框架

- **Fcitx5**（推荐）
- **Fcitx4**
- **IBus**

扩展会自动检测系统中安装的输入法框架。

## 开发

### 项目结构

```
auto-vim-ime/
├── src/                    # 源代码
│   ├── extension.ts        # 扩展入口
│   ├── ASTAnalyzer.ts      # Tree-sitter AST 分析器
│   ├── IMEManager.ts       # 输入法管理器
│   └── IMEStateManager.ts  # 输入法状态监听管理器
├── scripts/                # 辅助脚本
│   ├── download-wasm.js    # 下载 WASM 文件
│   └── prepare-sandbox.js  # 准备测试沙盒
├── wasm/                   # Tree-sitter WASM 文件
├── esbuild.js              # 构建脚本
├── package.json            # 项目配置
└── tsconfig.json           # TypeScript 配置
```

### 开发流程

```bash
# 安装依赖
npm install

# 监听模式（自动编译）
npm run watch

# 按 F5 启动调试（自动准备沙盒环境）
```

### 添加新语言支持

1. 下载对应的 Tree-sitter WASM 文件到 `wasm/` 目录
2. 在 `src/ASTAnalyzer.ts` 中添加：
   - `WASM_FILE_MAPPING`：语言 ID → WASM 文件名
   - `TARGET_NODE_TYPES`：语言 ID → 目标节点类型列表

### 测试

扩展使用 VS Code 沙盒环境进行测试：

1. 按 `F5` 启动调试
2. 在弹出的沙盒窗口中测试功能
3. 查看 "Auto Vim IME" 输出面板的日志

## 技术栈

- **TypeScript**：主要开发语言
- **Tree-sitter**：代码解析（通过 WASM）
- **esbuild**：构建工具
- **VS Code Extension API**：扩展框架

## 工作原理

1. **事件监听**：监听光标移动和文档变化事件
2. **AST 解析**：使用 Tree-sitter 解析代码，判断光标是否在注释/字符串中
3. **输入法切换**：通过 shell 命令调用 Fcitx5/Fcitx4/IBus 切换输入法
4. **状态栏更新**：实时更新状态栏显示

## 常见问题

### 扩展不工作

1. 检查是否安装了 VSCodeVim 扩展
2. 检查系统中是否安装了 Fcitx5/Fcitx4/IBus
3. 查看 "Auto Vim IME" 输出面板的日志

### 输入法没有切换

1. 确认输入法框架正在运行
2. 检查 `PATH` 环境变量是否包含输入法命令路径
3. 尝试手动执行 `fcitx5-remote -n` 或 `ibus engine` 测试

### 性能问题

- 扩展使用 30ms 防抖（文档变化）和 50ms 防抖（光标移动），响应速度快
- 注释检测优先走同步快速路径，Tree-sitter AST 分析仅在必要时执行（< 0.01ms/次）
- 如果仍有延迟，检查系统输入法框架是否正常

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'Add your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 提交 Pull Request

## 许可证

MIT License

## 致谢

- [Tree-sitter](https://tree-sitter.github.io/)：代码解析库
- [VSCodeVim](https://github.com/VSCodeVim/Vim)：Vim 模拟器
- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web)：Tree-sitter WASM 绑定

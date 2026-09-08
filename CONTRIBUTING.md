# 贡献指南

感谢您对 Auto IME 项目的关注！本文档将帮助您了解如何参与项目开发。

## 开发环境搭建

### 前置要求

- Node.js >= 16
- VS Code
- Linux 系统（Fcitx5/IBus）或 Windows

### 搭建步骤

1. **克隆仓库**
   ```bash
   git clone https://github.com/your-username/auto-ime.git
   cd auto-ime
   ```

2. **安装依赖**
   ```bash
   npm install
   ```
   此命令会自动下载 Tree-sitter WASM 文件。

3. **启动开发**
   ```bash
   # 监听模式（自动编译）
   npm run watch
   ```

4. **调试**
   - 按 `F5` 启动调试
   - 自动创建沙盒环境，安装 VSCodeVim 扩展
   - 在沙盒窗口中测试功能

## 项目结构

```
auto-ime/
├── src/                        # 源代码
│   ├── extension.ts            # 扩展入口，事件监听和生命周期管理
│   ├── ASTAnalyzer.ts          # Tree-sitter AST 分析器
│   ├── logger.ts               # 日志（console + Output Channel + 文件）
│   ├── core/                   # 平台无关核心
│   │   ├── controller.ts       # 切换决策：注释→中文，代码→英文
│   │   ├── state-tracker.ts    # 状态追踪：手动覆盖 + 外部切换检测
│   │   └── types.ts            # IPlatformAdapter 接口
│   ├── modes/                  # 事件源
│   │   ├── normal.ts           # 普通编辑器模式
│   │   └── vim.ts              # VSCodeVim 模式（ESC 劫持）
│   ├── platforms/              # 平台适配
│   │   ├── index.ts            # 工厂：win32 → WindowsAdapter，其它 → LinuxAdapter
│   │   ├── linux/adapter.ts    # Fcitx5 / IBus（自适应轮询）
│   │   └── windows/adapter.ts  # 双键盘策略
│   └── win32/                  # Windows FFI 层
│       ├── ime-ffi.ts          # koffi: user32 / imm32
│       ├── tsf-ffi.ts          # TSF（实验性）
│       ├── tsf-pipe.ts         # PowerShell 持久化管道
│       └── tsf-helper.cs       # TSF helper（C#）
├── test/                       # 测试
│   ├── mock-linux-ime-test.js  # Linux IME Mock 测试 (56 用例)
│   ├── mock-koffi-test.js      # Windows IME Mock 测试 (39 用例)
│   └── ast-analyzer-test.js    # AST 分析器测试 (59 用例)
├── scripts/                    # 辅助脚本
│   ├── check-env.js            # 环境检测（Linux 输入法框架连通性）
│   ├── download-wasm.js        # postinstall: 下载 WASM 文件
│   └── prepare-sandbox.js      # F5 前置: 准备测试沙盒
├── wasm/                   # Tree-sitter WASM 语言文件
├── dist/                   # 编译输出目录
├── esbuild.js              # 构建脚本
├── package.json            # 项目配置
└── tsconfig.json           # TypeScript 配置
```

## 核心模块

### extension.ts

扩展入口文件，负责：
- 注册 ESC 命令劫持
- 监听光标移动和文档变化
- 管理状态栏
- 协调 ASTAnalyzer、IMEController 与平台适配器

### ASTAnalyzer.ts

Tree-sitter AST 分析器，负责：
- 初始化 Tree-sitter WASM
- 按需加载语言 WASM
- 解析代码并判断光标是否在注释/字符串中
- 两级检测：同步文本快速路径 → Tree-sitter Query 精确判定

### core/controller.ts

切换决策中枢，负责：
- 根据上下文决定目标输入法（注释 → 中文，代码 → 英文，**字符串内不干预**）
- 先乐观更新状态栏，再调用平台适配器执行切换

### core/state-tracker.ts

输入法状态追踪器，负责：
- 检测用户手动切换（manualOverride：暂停自动切换，光标移动到新行后恢复）
- Linux: 自适应轮询（活跃 100ms / 空闲 500ms）
- Windows: koffi FFI 轮询

> **为什么用轮询而不是 D-Bus 信号？**
> 实测 Fcitx5 对远程切换（`fcitx5-remote`）不发出 InputContext 信号，
> `dbus-monitor` 只能观察到 method call，因此 v0.8.0 起改为异步自适应轮询。

### platforms/

平台适配层（`IPlatformAdapter` 接口 + 工厂）：
- `index.ts` 按 `process.platform` 分发：win32 → WindowsAdapter，其它 → LinuxAdapter（**暂无 macOS 实现**）
- Linux: Fcitx5（`fcitx5-remote` + profile 解析）/ IBus（`ibus engine`），均为 shell 命令
- Windows: 双键盘策略，通过 `PostMessageW(WM_INPUTLANGCHANGEREQUEST)` 切换布局（1033 ↔ 2052）
- Windows 单键盘场景的 TSF 方案尚未接入（见 `platforms/windows/adapter.ts` 中的 TODO）

## 开发规范

### 代码风格

- 使用 TypeScript 严格模式
- 遵循现有代码风格
- 添加必要的注释（特别是复杂的 AST 遍历逻辑）

### 提交规范

使用语义化提交信息：

```
feat: 添加新功能
fix: 修复 bug
docs: 更新文档
style: 代码格式调整
refactor: 重构代码
test: 添加测试
chore: 构建/工具变更
```

示例：
```
feat: 添加 Rust 语言支持
fix: 修复注释开头位置检测错误
docs: 更新 README 安装说明
```

### 分支策略

- `main`：稳定版本
- `develop`：开发分支
- `feature/*`：功能分支
- `fix/*`：修复分支

## 添加新语言支持

### 步骤

1. **下载 WASM 文件**
   ```bash
   # 从 tree-sitter-wasms 下载
   wget https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-<language>.wasm
   mv tree-sitter-<language>.wasm wasm/
   ```

2. **更新 ASTAnalyzer.ts**
   
   在 `WASM_FILE_MAPPING` 中添加映射：
   ```typescript
   'language-id': 'tree-sitter-language.wasm',
   ```

   在 `TARGET_NODE_TYPES` 中添加节点类型：
   ```typescript
   'language-id': ['comment', 'string_literal'],
   ```

3. **测试**
   - 创建测试文件验证注释和字符串检测
   - 确认 ESC 和状态栏功能正常

### 节点类型参考

不同语言的 Tree-sitter 节点类型可能不同。调试方法：

```javascript
// 在 Node.js 中测试
const Parser = require('web-tree-sitter');
const lang = await Parser.Language.load('wasm/tree-sitter-xxx.wasm');
parser.setLanguage(lang);
const tree = parser.parse('your code here');
console.log(tree.rootNode.toString());
```

## 测试

### 环境检测

```bash
npm run check-env
```

检测本地 Linux 输入法环境，验证 Fcitx5/IBus 的安装状态和守护进程连通性。`compile` 和 `watch` 脚本执行前会自动运行。

### Mock 测试

```bash
# Linux IME 测试（56 个用例）
node test/mock-linux-ime-test.js

# Windows IME 测试（39 个用例）
node test/mock-koffi-test.js

# AST 分析器测试（59 个用例）
node test/ast-analyzer-test.js
```

Mock 测试通过拦截 `Module._load` 注入模拟的 `child_process`、`fs`、`vscode` 模块，在无真实输入法环境下验证：
- 各 IME 管理器的查询/切换命令
- 责任链降级（Fcitx5 → IBus → NullManager）
- 超时与异常安全
- profile 文件解析
- bundle 编译产物完整性

### 手动测试

1. 按 `F5` 启动调试
2. 在沙盒窗口中：
   - 按 `i` 进入 Insert 模式
   - 移动光标到注释/字符串
   - 观察状态栏变化
   - 按 `ESC` 测试强制切换

### 检查日志

查看 "Auto IME" 输出面板：
- `[AST]`：AST 解析日志
- `[IME]`：输入法切换日志
- `[IMEState]`：输入法状态监听日志
- `[Mode]`：模式切换日志

## 提交 Pull Request

1. Fork 本仓库
2. 创建功能分支
3. 提交更改
4. 推送分支
5. 创建 Pull Request

### PR 描述模板

```markdown
## 变更说明

简要描述本次变更的内容。

## 变更类型

- [ ] 新功能
- [ ] Bug 修复
- [ ] 文档更新
- [ ] 重构
- [ ] 其他

## 测试

描述如何测试本次变更。

## 相关 Issue

关联的 Issue 编号。
```

## 问题反馈

提交 Issue 时请包含：
- 操作系统和版本
- VS Code 版本
- 输入法框架和版本
- 扩展版本
- 复现步骤
- 错误日志（"Auto IME" 输出面板）

## 许可证

贡献代码将采用与项目相同的 MIT 许可证。

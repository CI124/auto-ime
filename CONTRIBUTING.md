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
│   ├── extension.ts            # 装配层：建对象图、选模式、接生命周期与键位闸门
│   ├── analysis/ASTAnalyzer.ts # Tree-sitter AST 分析器（实现 IAnalyzer）
│   ├── infra/logger.ts         # 日志（console + Output Channel + 文件）
│   ├── core/                   # 平台无关核心
│   │   ├── controller.ts       # 切换决策：注释→中文，代码→英文，不干预→不动
│   │   ├── state-tracker.ts    # 状态追踪：手动覆盖 + 消费外部切换回调
│   │   ├── poller.ts           # ValuePoller 轮询原语（start/pause/resume/stop）
│   │   └── types.ts            # IPlatformAdapter / IAnalyzer / IModeListener 契约
│   ├── modes/                  # 事件源
│   │   ├── normal.ts           # 普通编辑器模式
│   │   └── vim.ts              # VSCodeVim 模式（ESC 劫持 + 游标样式状态机）
│   ├── platforms/              # 平台适配
│   │   ├── index.ts            # 工厂：win32 → WindowsAdapter，其它 → LinuxAdapter
│   │   ├── linux/adapter.ts    # Fcitx5 / IBus 选择 + 自适应轮询
│   │   ├── linux/shell.ts      # bash 执行原语（同步/异步/探测、超时、PATH）
│   │   ├── linux/fcitx5-profile.ts  # 读 fcitx5 profile 得出中/英输入法名
│   │   ├── windows/adapter.ts  # 双键盘 / 单键盘策略分发与降级
│   │   ├── windows/dual-keyboard.ts     # 双键盘（键盘布局切换）
│   │   └── windows/single-keyboard.ts   # 单键盘（模拟 IME 切换热键）
│   └── win32/                  # Windows FFI 层
│       └── ime-ffi.ts          # koffi: user32 / kernel32（布局切换 + keybd_event 注入）
├── test/                       # 测试（全部针对真实源码，npm test 串跑）
│   ├── poller-test.js          # ValuePoller 行为 (7 用例)
│   ├── controller-test.js      # IMEController 状态机 (16 用例)
│   ├── vim-mode-test.js        # Vim 监听器与定时器 (7 用例)
│   ├── ast-analyzer-test.js    # AST 分析器 (27 用例)
│   ├── mock-koffi-test.js      # Windows 双键盘 + 端到端激活 (31 用例)
│   ├── mock-tsf-test.js        # Windows 单键盘 (18 用例)
│   └── mock-linux-ime-test.js  # Linux IME (56 用例)
├── scripts/                    # 辅助脚本与门禁
│   ├── check-granularity.js    # 粒度/复杂度门禁（npm run lint）
│   ├── verify-repo.js          # 仓库自检：.gitignore 白名单漏放行即失败
│   ├── verify-wasm.js          # wasm 齐备性与清单一致性门禁
│   ├── wasm-manifest.js        # wasm 清单单一来源（download 与 verify 共用）
│   ├── download-wasm.js        # postinstall: 校验下载 WASM
│   ├── check-env.js            # 环境诊断（Linux 输入法；非构建前置）
│   ├── launch-test-env.js      # 隔离的手动测试环境（便携 VS Code）
│   └── prepare-sandbox.js      # F5 前置: 准备测试沙盒
├── docs/                       # 决策记录（ADR）与巡检计划，参与仓库自检
│   ├── adr/                    # 架构决策记录，每轮重构后新增/更新
│   └── baseline-granularity.json  # 存量超限文件基线（只许变小）
├── wasm/                   # Tree-sitter WASM 语言文件（不入库，postinstall 下载）
├── dist/                   # 编译输出目录
├── esbuild.js              # 构建脚本
├── package.json            # 项目配置
└── tsconfig.json           # TypeScript 配置
```

## 核心模块

### extension.ts

装配层（本身不做决策），负责：
- 构建对象图：适配器 → 分析器 → 状态追踪 → 控制器，失败则整体 dispose
- 检测 Vim 并选择模式监听器；Vim 晚加载时延后重测一次
- 管理状态栏、切换命令、窗口焦点同步
- `auto-ime.activated` 键位闸门：只有接线全部成功才打开，否则 ESC 等键位回落给宿主

### analysis/ASTAnalyzer.ts

Tree-sitter AST 分析器（实现 `IAnalyzer`），负责：
- `supports(languageId)`：该语言有无已登记的 wasm + query（无则上层完全不干预）
- 初始化 Tree-sitter WASM；按需加载语言 WASM（失败只记一次日志并降级）
- 两级检测：同步文本快速路径（行注释 / 块注释，带引号成对校验）→ Tree-sitter Query
- 解析为全量而非增量（原因见 `docs/adr/0003`），按 `(uri, version)` 缓存文档文本

### core/controller.ts

切换决策中枢，负责：
- 先问 `IAnalyzer.supports()`：无判定能力的语言整轮不干预
- 根据上下文决定目标输入法（注释 → 中文，代码 → 英文，**字符串内不干预**）
- 事件级防抖（按文档行数 10/30/60ms 尾随），同一次操作只分析最后一批
- 先乐观更新状态栏，再调用平台适配器执行切换；适配器报告失败时记 FAILED 告警

### core/state-tracker.ts

输入法状态跟踪器，只**消费**回调，故意不自建定时器：
- 区分自动切换与外部（手动）切换；manualOverride 期间暂停自动切换，
  光标移到新行后恢复
- `startListening()` 把回调交给适配器，并用返回值告知上层“外部切换可不可观察”，
  避免叠加第二层轮询
- `setObserving(focused)` 仅转发焦点信号给适配器（定时器归适配器所有）

> **为什么用轮询而不是 D-Bus 信号？**
> 实测 Fcitx5 对远程切换（`fcitx5-remote`）不发出 InputContext 信号，
> `dbus-monitor` 只能观察到 method call，因此 v0.8.0 起改为异步自适应轮询。

### platforms/

平台适配层（`IPlatformAdapter` 接口 + 工厂）：
- `index.ts` 按 `process.platform` 分发：win32 → WindowsAdapter，其它 → LinuxAdapter
  （**暂无 macOS 实现**；macOS 会落到 LinuxAdapter 并因探测不到框架而 `isReady()=false`）
- Linux: Fcitx5（`fcitx5-remote` + profile 解析）/ IBus（`ibus engine`），均为 shell 命令；
  两者共享 `CommandLineImeManager`，子类只提供“三条命令 + 日志文案”。
  探不到框架时 `manager = null`，切换变为无操作（**没有**“NullManager 责任链降级”这种东西）
- Windows 双键盘：`PostMessageW(WM_INPUTLANGCHANGEREQUEST)` 切换布局（1033 ↔ 2052），
  前台线程 Language ID 可读，因此能轮询到外部切换
- Windows 单键盘：**已接入**（v0.9.0-beta）——写 TSF compartment 与 IMM32 对
  VS Code / Electron 这类 TSF-only 宿主均无效（实测），因此改为用 `keybd_event`
  注入输入法自己的切换热键。代价：这是“翻转”而不是“绝对设置”，且无跨进程读取，
  用户手动切换会造成状态漂移（详见 `platforms/windows/single-keyboard.ts` 头部说明）

### 约定但未写进类型的三个不变式

改核心逻辑前先读懂这三条，它们都有测试守着：

1. `IMEController.analyzeAndSwitch()` **不得抛出、不得产生未处理 rejection**（调用方都是
   fire-and-forget），分析失败只能记 ERROR 日志并“本轮不切换”
2. 无判定能力的语言（`IAnalyzer.supports()` 为 false）整轮 no-op；`{ match: false }` 只
   表示“确认不是注释/字符串”（`docs/adr/0005`）
3. `ValuePoller.pause()` 保留基线、`stop()` 不保留；失焦期间的真实切换必须在恢复后上报
   一次（`docs/adr/0006`）

## 开发规范

### 代码风格与门禁

- 使用 TypeScript 严格模式；`npx tsc --noEmit` 必须 0 错误
- 注释要写“为什么”而不是“做了什么”，尤其是 AST 遍历、平台限制与已试过不行的方案
- **`npm run lint`** 是硬门禁（超硬上限或存量变大即拒合）：文件 400/600 行、函数 60/100 行、
  分支 12/15、嵌套 4/5、参数 5/6。阈值理由见 `docs/adr/0004`
- 存量超限文件登记在 `docs/baseline-granularity.json`，**只许变小不许变大**；
  缩小后跑 `node scripts/check-granularity.js --update-baseline` 收紧基线
- **每轮架构调整/权衡需在 `docs/adr/` 新增一条记录**：背景、决策、代价、被否决方案、
  复审触发条件。没有记录的决策等于下次只能猜
- CI 会跑仓库自检（`scripts/verify-repo.js`）：新增源码/测试/CI/文档目录若忘在 `.gitignore`
  白名单里放行，第一步就会失败

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

1. **下载 WASM 文件**（或直接跑 `npm install` 让 postinstall 拉取）
   ```bash
   wget https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-<language>.wasm
   mv tree-sitter-<language>.wasm wasm/
   ```

2. **登记哈希清单** `scripts/wasm-manifest.js`
   把文件名与它的 SHA-256 加进 `CHECKSUMS`。不加则 `npm run verify-wasm` 会直接报
   “ASTAnalyzer 引用了…但清单未登记”（wasm 不入库，漏登记的症状是“该语言的注释永远
   不切中文”，难归因，所以用门禁前移成构建失败）。

3. **更新 `src/analysis/ASTAnalyzer.ts`** —— 只需在 `LANGUAGE_PROFILES` 加**一条**：
   ```typescript
   ruby: slashSlashLineProfile('tree-sitter-ruby.wasm', STRING_LITERAL_QUERY),
   // 或写全字段：{ wasmFile, query, lineComments, blockComments }
   ```
   `query` 的捕获名必须是 `@comment` / `@string`；`lineComments`/`blockComments` 只喂
   快路径，拿不准就留空，反正会回落到 AST（它才是真值源）。

4. **测试**
   - `node scripts/verify-wasm.js` 与 `node test/ast-analyzer-test.js` 会自动把新语言
     拉进清单一致性校验；`supports()` 用例里的已登记语言列表需同步补一行
   - 在真实 VS Code 里验证注释/字符串/代码三种上下文（`npm run test-env`）

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

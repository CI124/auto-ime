# ADR 0004: 粒度/复杂度门禁的工具选型、阈值与分级

- 状态：Accepted
- 日期：2026-09-21
- 相关：`scripts/check-granularity.js`、`docs/baseline-granularity.json`、
  `.github/workflows/ci.yml`、`docs/adr/0003-full-parse-instead-of-unedited-incremental.md`

## 背景

上一轮巡检（`docs/REFACTOR_PLAN.md`）做完 4 个批次后，项目**没有任何自动化门禁**：
无 lint 依赖、无 lint 脚本、无 pre-commit、无死代码/重复代码/覆盖率检查。
所有"文件不要变大、函数不要变长"的约束只存在于口头与文档里。

`src/` 当前 15 个文件最大 383 行，指标本身健康 —— 但"现在健康"和"能保持健康"是两件事。
按治理规范：*写进文档但工具不检查的规则，等于没有*。

## 决策 1：不引入 ESLint，改用仓库内零依赖门禁脚本

- 理由：本项目只有 15 个源文件、需要守的只有 5 个数字；引 ESLint 会新增约 50 个依赖包
  进 `package-lock.json`，而规范要求"新增依赖必须审查漏洞"。用已经在 devDependencies 里的
  `typescript` 反而**零新增依赖**，且能力刚好匹配。
- 代价：只覆盖粒度/复杂度，不含代码风格、未使用变量、import 顺序等。这些**明确不在本轮范围**，
  若将来需要，再引 ESLint 并把本脚本作为其补充而非替换。
- 被否决：ESLint + 全套规则（成本/收益不匹配当前规模）；SonarQube（需要服务）。

## 决策 2：度量必须建立在真 AST 上

第一版实现用正则启发式（"行首含 `(` 且行尾是 `{`"）识别函数，实测对 `src/` **只识别到 22 个函数块**，
其中 `src/modes/vim.ts`、`src/core/state-tracker.ts`、`src/platforms/windows/adapter.ts`
整文件报 0 —— 因为多行签名与正则字面量里的引号会污染词法剥离。

这版脚本已经改好并通过了"放一个 7 参数/6 层嵌套的文件进去必须 FAIL"的自检，
但结论值得留在 ADR 里：**一个识别不出函数的粒度门禁，比没有门禁更危险，因为它显示绿色。**

现在改用 `ts.createSourceFile`，并对每个目标目录设**识别数下限**
（`MIN_FUNCTIONS`：src 60 / test 60 / scripts 20），低于下限即判失败，防止再次静默空跑。
当前实测：29 个文件、709 个函数。

## 决策 3：阈值（严于通用默认，并写清理由）

| 维度 | src 软/硬 | test、scripts 软/硬 | 理由 |
|---|---|---|---|
| 文件行数 | 400 / 600 | 600 / 700 | 项目小、模块集中、AI 高频改动 → 比通用 600 更严；448 行的 linux/adapter 走 baseline |
| 函数行数 | 60 / 100 | 100 / 120（**不阻断**） | 核心层函数应能一屏读完；测试用例表是数据量不是认知负担 |
| 分支数（圈复杂度代理） | 12 / 15 | 15 / 20（**不阻断**） | 按 TS AST 统计 if/for/while/case/catch/三元/`&&`/`\|\|`/`??` + 基线 1 |
| 嵌套深度 | 4 / 5 | 4 / 5（**不阻断**） | 只统计控制结构，对象字面量不加深（避免 mock 配置误报） |
| 参数个数 | 5 / 6 | 5 / 6（阻断） | src 现状最大 4，阈值不产生任何噪音 |

**为什么 `test/`、`scripts/` 大部分维度不阻断**：门禁一旦误报，人的理性反应是关掉它。
只在自己有把握的维度上拦人，其余降级为提示，是让门禁能长期活着的条件。
**复审触发**：若某季度内 `src/` 无新增违规且软档提示数不再变化，可把 `test/` 的函数行数
也纳入阻断。

## 决策 4：存量走 baseline 冻结增长

`src/platforms/linux/adapter.ts`（448）、`test/mock-linux-ime-test.js`（635）超过软档但
不超硬档 → 登记进 `docs/baseline-granularity.json`，规则是**只许变小不许变大**：变小会提示
收紧基线，变大或凭空新增超限文件一律失败。这是"旧代码渐进、禁止继续恶化"的机器化落地。

## 决策 5：`check-env.js` 退出构建链路

原先 `precompile`/`prewatch` 会跑 `scripts/check-env.js`，而它在 Linux 上「未检测到可用
输入法框架」时 `exit 1`。也就是说：**只要把它接到 CI 的 ubuntu runner（无头环境必然没有
Fcitx5/IBus daemon），构建就会红** —— 这是把"运行时环境诊断"错当"构建前置"。
改为独立 `npm run check-env` 诊断命令；顺带修掉其过期文案（不再提 D-Bus 依赖、
不再提已不存在的 `NullManager`）。

## 例外清单（显式管理）

不参与门禁：`dist/**`（esbuild 产物）、`node_modules/**`、`wasm/**`（二进制）、
`.vscode-test-env/**`（隔离测试环境）、`*.d.ts`（类型定义）。
其中 `wasm/**` 与 `.vscode-test-env/**` 属于"有意排除"，理由记录在 `.gitignore` 尾部与 ADR 0002。

## 本地验证命令

```
npm run lint                     # 门禁
node scripts/check-granularity.js --update-baseline   # 登记/收紧存量基线
GRANULARITY_DEBUG=1 npm run lint # 查看每个文件识别到多少函数
```

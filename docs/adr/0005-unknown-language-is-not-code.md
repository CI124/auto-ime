# ADR 0005: 无判定能力的语言一律不干预（不猜"是代码"）

- 状态：Accepted
- 日期：2026-09-21
- 相关：`src/core/types.ts`（`IAnalyzer.supports`）、`src/analysis/ASTAnalyzer.ts`、
  `src/core/controller.ts`、`README.md`

## 背景

`LANGUAGE_PROFILES` 登记了 15 个 languageId（13 份 wasm）。对未登记的语言，
`isCursorInCommentOrString()` 只能返回 `{ match: false, type: null }`，而
`controller.doAnalyze()` 把 `match:false` 解释为"光标在代码里"→ **切英文**。

后果集中在最高频的中文写作场景：

| 场景 | 旧行为 |
|---|---|
| 在 `README.md` / `*.md` 笔记里写中文 | 每次游标移动/打字都被判为"代码"→ 抢切回英文，用户无法正常写中文 |
| 在 `plaintext`、`jsonc`、`yaml`、`xml` 里写中文注释 | 同上 |
| 编辑器输出面板、他人扩展创建的虚拟文档 | 靠 scheme 过滤躲过，属于巧合而非设计 |

也就是说：扩展宣传"字符串内不干预"（方案 A，不干预优于误伤），但在它**根本没有判定能力**的
语言上，却给出了最武断的结论。

## 决策

区分"**确认不是注释**"与"**我不知道**"：

1. `IAnalyzer` 新增 `supports(languageId): boolean`；`ASTAnalyzer` 直接以
   `LANGUAGE_PROFILES` 为唯一真值源实现（新增语言只改那张表，方法自动跟上，不存在手工同步漂移）。
2. `controller.doAnalyze()` 在方案判定之前先问 `supports()`：**不支持的语言整轮 no-op**
   （不分析、不切换、不改状态栏），只记一条 debug。
3. 位置在选择游标守卫之后、`manualOverride` 处理之前 —— 对不支持的语言不产生任何副作用，
   因此也不会污染 `lastPositionLine` 之外的状态（唯一影响见下方"代价"）。

## 为什么不直接"加 markdown/plaintext 支持"

那才是直觉方案，但会引入新问题：markdown 的"注释"语义与代码语言不同（整篇都可视为正文），
tree-sitter-markdown 的节点命名与现有 query 模式不匹配，需要单独设计判定规则；而**当前**
用户遇到的问题是"写中文被打断"。不干预立即解决它，且与方案 A 一致。
真要给 markdown 加判定，应作为独立需求（含它自己的判定规则与用例），不是本 ADR 的范围。

## 代价与复审触发

- 代价 1：未登记语言上，状态栏不再跟随真实输入法（因为整轮跳过）。可接受 —— 之前它
  显示的也是"我强行切成英文"后的状态，并无参考价值。
- 代价 2：`stateTracker.updatePosition()` 对未登记语言不再调用，因此"从 md 文件移回
  ts 文件且行号恰好相同"时，manualOverride 可能多保持一轮。影响是"少切一次"，不会误切。
- **复审触发**：若用户反馈集中在"希望 md 里注释/代码块能自动切"，则实现 markdown 专用
  profile（含 fenced code block 判定），并把本 ADR 标记为 Superseded。

## 锁住该行为的测试

- `test/controller-test.js`：未映射语言（markdown）→ 切换调用数为 0、分析调用数为 0、
  模式保持原样；以及"已映射语言仍正常处理"防全局短路。
- `test/ast-analyzer-test.js`：`supports()` 对 15 个已登记 id 为 true、对
  markdown/plaintext/未知 id 为 false（防"加了表但方法没同步"）。

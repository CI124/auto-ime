/**
 * scripts/check-granularity.js — 文件粒度与复杂度门禁（零新增依赖）
 *
 * 治什么：文件越大，理解/检索/修改的上下文负载越高，改 A 坏 B 与漏改的概率越大。
 * 本门禁把阈值落成机器断言，而不是靠 review 自觉 —— 规则不进工具链等于没有。
 *
 * 为什么用 TypeScript 编译器 API 而不是正则启发式：本仓库已把 typescript 作为
 * devDependency（CI 在 lint 之前已 npm ci），拿真 AST 是免费的。反例是真实发生过的：
 * 第一版用「行首含 ( 且行尾是 {」识别函数，实测对 src/ 只识别到 22 个函数块，
 * vim.ts / state-tracker.ts 整文件报 0 —— 因为多行签名、正则字面量里的引号会污染
 * 词法剥离。这种门禁比没有更危险：它看起来是绿的。用真 AST 后不存在"漏识别"。
 *
 * 分级原则（enforce 逐维度开关）：只有在某维度上【不会误报】才允许阻断合并。
 *   - src/ 为核心代码：五个维度全硬；
 *   - test/、scripts/ 为开发者资产：只硬校文件行数与参数数，其余仅提示。
 *     理由：测试文件的 run()/main() 本质是"用例表"，行数是数据量不是认知负担，
 *     强行阻断只会逼人把用例拆成更难读的碎片（那是机械执行指标，不是治理）。
 *   - 超出软档但未超硬档的【存量】文件记入 docs/baseline-granularity.json，
 *     只许变小不许变大（冻结增长）。
 * 阈值取值理由见 docs/adr/0004-file-granularity-gates.md。
 *
 * 用法: node scripts/check-granularity.js [--update-baseline]
 * 自检: GRANULARITY_DEBUG=1 打印每个文件识别到的函数块数
 * 退出码: 0 = 合规, 1 = 存在超硬档违规或存量增长
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(ROOT, 'docs', 'baseline-granularity.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

const ALL_ENFORCE = { fileLines: true, fnLines: true, branches: true, depth: true, params: true };
const DATA_ONLY_ENFORCE = { fileLines: true, fnLines: false, branches: false, depth: false, params: true };

const TARGETS = [
    {
        dir: 'src',
        pattern: /\.(ts|js)$/,
        enforce: ALL_ENFORCE,
        limits: { fileLines: 400, hardFileLines: 600, fnLines: 60, hardFnLines: 100, branches: 12, hardBranches: 15, depth: 4, hardDepth: 5, params: 5, hardParams: 6 },
    },
    {
        dir: 'test',
        pattern: /\.js$/,
        enforce: DATA_ONLY_ENFORCE,
        limits: { fileLines: 600, hardFileLines: 700, fnLines: 100, hardFnLines: 120, branches: 15, hardBranches: 20, depth: 4, hardDepth: 5, params: 5, hardParams: 6 },
    },
    {
        dir: 'scripts',
        pattern: /\.js$/,
        enforce: DATA_ONLY_ENFORCE,
        limits: { fileLines: 600, hardFileLines: 700, fnLines: 100, hardFnLines: 120, branches: 15, hardBranches: 20, depth: 4, hardDepth: 5, params: 5, hardParams: 6 },
    },
];

/** 显式例外：生成物与产物不参与（见 ADR 0004） */
const EXCLUDED_PATHS = [
    /^dist\//,
    /^node_modules\//,
    /^wasm\//,
    /^\.vscode-test-env\//,
    /\.d\.ts$/,
];

// ============================================================
// AST 度量
// ============================================================

const FUNCTION_NODES = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.FunctionExpression,
]);

/** 只有真正的控制结构才加深嵌套；对象字面量/解构/块语句不算认知嵌套 */
const NESTING_NODES = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.CaseBlock,
    ts.SyntaxKind.TryStatement,
]);

const BRANCH_NODES = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.CaseClause,
    ts.SyntaxKind.DefaultClause,
    ts.SyntaxKind.CatchClause,
    ts.SyntaxKind.ConditionalExpression,
]);

function nameOf(node) {
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
    return '<anonymous>';
}

/** 统计一个函数体内的嵌套深度与分支数（遇到内层函数不穿透） */
function measureBody(body, isFunctionBoundary) {
    let depth = 0;
    let maxDepth = 0;
    let branches = 0;

    const visit = (n) => {
        if (n !== body && isFunctionBoundary(n)) return;
        const counted = NESTING_NODES.has(n.kind);
        if (counted) {
            depth++;
            if (depth > maxDepth) maxDepth = depth;
        }
        if (BRANCH_NODES.has(n.kind)) branches++;
        if (ts.isBinaryExpression(n) &&
            (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
             n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
             n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
            branches++;
        }
        n.forEachChild(visit);
        if (counted) depth--;
    };
    visit(body);
    return { maxDepth, branches };
}

function collectFunctions(sourceFile) {
    const fns = [];
    const isFunctionBoundary = (n) => FUNCTION_NODES.has(n.kind);

    const visit = (node) => {
        if (isFunctionBoundary(node) && node.body) {
            const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
            const { maxDepth, branches } = measureBody(node.body, isFunctionBoundary);
            const params = node.parameters ? node.parameters.length : 0;
            fns.push({
                name: nameOf(node),
                startLine,
                lines: endLine - startLine + 1,
                params,
                depth: maxDepth + 1,   // +1：函数体本身算一层
                branches: branches + 1, // 圈复杂度惯例：基线 1
            });
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return fns;
}

// ============================================================
// 判级
// ============================================================

/**
 * 单指标判级。enforced=false 时最多提示，绝不阻断（用于不打算在该维度上拦人的目录）。
 * 收成单个 descriptor 对象：本门禁自己也得守住参数个数上限。
 */
function checkMetric({ errors, warnings, enforced, where, label, value, soft, hard }) {
    if (value > hard) {
        const msg = `${where}: ${label} ${value} > 硬上限 ${hard}`;
        if (enforced) errors.push(msg);
        else warnings.push(`${msg}（本目录不阻断，仅提示）`);
        return;
    }
    if (value > soft) warnings.push(`${where}: ${label} ${value} > 软上限 ${soft}`);
}

function walk(dir, collect = []) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return collect;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel, collect);
        else collect.push(rel);
    }
    return collect;
}

// ============================================================
// 主流程
// ============================================================

const baseline = fs.existsSync(BASELINE_FILE)
    ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'))
    : { files: {} };

const errors = [];
const warnings = [];
const currentSizes = {};
const detectedByTarget = {};

for (const target of TARGETS) {
    detectedByTarget[target.dir] = 0;
    for (const rel of walk(target.dir)) {
        const posix = rel.replace(/\\/g, '/');
        if (EXCLUDED_PATHS.some((re) => re.test(posix)) || !target.pattern.test(posix)) continue;

        const raw = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
        const fileLines = raw.split('\n').length;
        currentSizes[posix] = fileLines;
        const limits = target.limits;

        if (fileLines > limits.hardFileLines) {
            errors.push(`${posix}: 文件 ${fileLines} 行 > 硬上限 ${limits.hardFileLines}`);
        } else if (fileLines > limits.fileLines) {
            const allowed = baseline.files[posix];
            if (allowed === undefined) {
                errors.push(`${posix}: 文件 ${fileLines} 行 > 软上限 ${limits.fileLines}，且不在 baseline 中`
                    + `\n     新代码必须直接合规；确属存量请跑 node scripts/check-granularity.js --update-baseline 登记`);
            } else if (fileLines > allowed) {
                errors.push(`${posix}: 存量超限文件【又变大了】 ${allowed} → ${fileLines} 行（冻结增长被违反）`);
            } else if (fileLines < allowed) {
                warnings.push(`${posix}: 已缩到 ${fileLines} 行（baseline 记 ${allowed}），可 --update-baseline 收紧`);
            }
        }

        const sourceFile = ts.createSourceFile(posix, raw, ts.ScriptTarget.ES2022, true,
            posix.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
        const fns = collectFunctions(sourceFile);
        detectedByTarget[target.dir] += fns.length;
        if (process.env.GRANULARITY_DEBUG) console.log(`  [debug] ${posix}: ${fns.length} 个函数`);

        for (const fn of fns) {
            const where = `${posix}:${fn.startLine} ${fn.name}()`;
            const base = { errors, warnings, where };
            checkMetric({ ...base, enforced: target.enforce.fnLines, label: '函数行数', value: fn.lines, soft: limits.fnLines, hard: limits.hardFnLines });
            checkMetric({ ...base, enforced: target.enforce.branches, label: '分支数', value: fn.branches, soft: limits.branches, hard: limits.hardBranches });
            checkMetric({ ...base, enforced: target.enforce.depth, label: '嵌套深度', value: fn.depth, soft: limits.depth, hard: limits.hardDepth });
            checkMetric({ ...base, enforced: target.enforce.params, label: '参数个数', value: fn.params, soft: limits.params, hard: limits.hardParams });
        }
    }
}

// 防"空跑"：识别数低于下限说明解析或采集出了问题，比"无违规"更优先报失败
const MIN_FUNCTIONS = { src: 60, test: 60, scripts: 20 };
for (const [dir, min] of Object.entries(MIN_FUNCTIONS)) {
    const got = detectedByTarget[dir] || 0;
    if (got < min) {
        errors.push(`${dir}/ 只识别到 ${got} 个函数（期望 >= ${min}）——采集逻辑或解析失效，`
            + `本门禁当前只能校行数，请勿当作已检查函数粒度`);
    }
}

// baseline 里已消失/已合规的文件要清掉，否则留下"已修好但记录还在"的死配置
for (const rel of Object.keys(baseline.files)) {
    if (!(rel in currentSizes)) warnings.push(`baseline 含已不存在的文件: ${rel}（请 --update-baseline 清理）`);
}

if (UPDATE_BASELINE) {
    const files = {};
    for (const target of TARGETS) {
        for (const [rel, lines] of Object.entries(currentSizes)) {
            if (rel.startsWith(`${target.dir}/`) && lines > target.limits.fileLines && lines <= target.limits.hardFileLines) {
                files[rel] = lines;
            }
        }
    }
    const payload = {
        note: '由 node scripts/check-granularity.js --update-baseline 生成。登记的存量超限文件只许变小不许变大（冻结增长）。',
        files,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    console.log(`[granularity] baseline 已更新：登记 ${Object.keys(files).length} 个存量超限文件`);
}

for (const w of warnings) console.log(`  [warn] ${w}`);
if (errors.length) {
    console.error(`[granularity] FAIL — ${errors.length} 项违规`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
}
console.log(
    `[granularity] OK — 扫描 ${Object.keys(currentSizes).length} 个文件、真 AST 识别 `
    + `${Object.values(detectedByTarget).reduce((a, b) => a + b, 0)} 个函数`
    + `（${warnings.length} 条软档提示，存量冻结生效中）`
);

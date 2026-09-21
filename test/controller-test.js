/**
 * IMEController 行为测试 —— 针对【真实源码】
 *
 * 用 esbuild 现场把真实的 src/core/controller.ts 打包为内存模块并加载，
 * 注入 fake 的 adapter / analyzer / stateTracker / statusBarItem，验证核心决策状态机：
 *   - 方案A：注释→中文，代码→英文，字符串→不切换
 *   - fast 路径命中时不触发 AST
 *   - 已处于目标模式则 skip
 *   - manualOverride 行为
 *   - switchTo 会【消费 success】：失败时记 FAILED 日志（对应 DD2）
 *   - analyzeAndSwitch 的行级防抖：同一 tick 内多次事件只分析一次
 *
 * 运行：node test/controller-test.js（需先 npm run compile，仅用于其它测试，本文件不依赖 dist）
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const REPO_ROOT = path.join(__dirname, '..');

// vscode 兜底 mock：controller 运行期只用到 ThemeColor
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return { ThemeColor: class { constructor(id) { this.id = id; } } };
    return origLoad.call(this, request, parent, isMain);
};

function loadController() {
    const result = esbuild.buildSync({
        stdin: { contents: `export { IMEController } from './src/core/controller';`, resolveDir: REPO_ROOT, loader: 'ts', sourcefile: 'ctl-entry.ts' },
        bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node16', external: ['vscode'], logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const mod = { exports: {} };
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    fn(mod.exports, require, mod, path.join(REPO_ROOT, 'ctl-entry.js'), REPO_ROOT);
    return mod.exports.IMEController;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// fakes
// ============================================================
function makeAdapter() {
    const calls = { en: 0, zh: 0, enResult: { success: true, method: 'layout' }, zhResult: { success: true, method: 'layout' } };
    return {
        name: 'fake', calls,
        isReady: () => true,
        queryMode: () => 'en',
        switchToEnglish() { calls.en++; return calls.enResult; },
        switchToChinese() { calls.zh++; return calls.zhResult; },
    };
}
function makeAnalyzer(fastResult, astResult) {
    const stats = { fastCalled: 0, astCalled: 0 };
    return {
        stats,
        init() {},
        dispose() {},
        supports: () => true,
        isCursorInCommentFast() { stats.fastCalled++; return fastResult; },
        async isCursorInCommentOrString() { stats.astCalled++; return astResult; },
    };
}
// 巡检 C3：分析器抛错不得变成未处理 rejection（扩展宿主会静默崩掉这一轮判定）
function makeThrowingAnalyzer(mode) {
    const stats = { fastCalled: 0, astCalled: 0 };
    return {
        stats,
        init() {},
        dispose() {},
        supports: () => true,
        isCursorInCommentFast() {
            stats.fastCalled++;
            if (mode === 'fast-throw') throw new Error('boom-fast');
            return null;
        },
        isCursorInCommentOrString() {
            stats.astCalled++;
            if (mode === 'ast-reject') return Promise.reject(new Error('boom-ast'));
            return Promise.resolve({ match: false, type: null });
        },
    };
}
function makeTracker() {
    const state = { manualOverride: false, lastLine: -1, autoSwitches: [], syncs: 0 };
    return {
        state,
        startListening: async () => 'not-observable',
        stopListening() {},
        setOnChangeCallback() {},
        syncState() { state.syncs++; },
        queryMode: () => 'en',
        isManualOverride: () => state.manualOverride,
        markManualSwitch() { state.manualOverride = true; },
        resetManualOverride() { state.manualOverride = false; },
        isDifferentPosition: (line) => line !== state.lastLine,
        updatePosition(line) { state.lastLine = line; },
        notifyAutoSwitch(mode) { state.autoSwitches.push(mode); },
    };
}
function makeStatusBar() { return { text: '', tooltip: '', backgroundColor: undefined, command: '', show() {}, dispose() {} }; }
function makeLogger() {
    const lines = [];
    return {
        lines,
        debug: (m) => lines.push(`DEBUG ${m}`),
        info: (m) => lines.push(`INFO ${m}`),
        warn: (m) => lines.push(`WARN ${m}`),
        error: (m) => lines.push(`ERROR ${m}`),
    };
}
function makeEditor(languageId = 'typescript', line = 0, lineCount = 10) {
    return {
        document: {
            languageId,
            lineCount,
            uri: { scheme: 'file', toString: () => 'file:///a.ts' },
            version: 1,
            getText: () => '',
            lineAt: () => ({ text: '' }),
            offsetAt: () => 0,
        },
        selections: [{ active: { line, character: 2 } }],
        options: { cursorStyle: 1 },
    };
}

// ============================================================
// 测试框架
// ============================================================
const IMEController = loadController();
let testCount = 0, passCount = 0, failCount = 0;
const queue = [];
const unhandledRejections = [];
function test(name, fn) { queue.push({ name, fn }); }

function build({ fast = null, ast = { match: false, type: null }, manualOverride = false, analyzer = null, supported = true } = {}) {
    const adapter = makeAdapter();
    const analyzerImpl = analyzer || makeAnalyzer(fast, ast);
    if (!analyzer && !supported) analyzerImpl.supports = () => false;
    const tracker = makeTracker();
    tracker.state.manualOverride = manualOverride;
    const statusBar = makeStatusBar();
    const logger = makeLogger();
    const controller = new IMEController(adapter, analyzerImpl, tracker, statusBar, logger);
    return { adapter, analyzer: analyzerImpl, tracker, statusBar, logger, controller };
}

async function run() {
    // 捕获本轮任何未处理 rejection（修复前：doAnalyze 抛错会逸出到进程级）
    process.on('unhandledRejection', (reason) => unhandledRejections.push(String(reason && reason.message ? reason.message : reason)));

    console.log('═══════════════════════════════════════');
    console.log('  IMEController 行为测试（真实源码）');
    console.log('═══════════════════════════════════════\n');

    test('注释 + 英文态 → 切换到中文', async () => {
        const { adapter, controller } = build({ ast: { match: true, type: 'comment' } });
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(50);
        assert.strictEqual(adapter.calls.zh, 1, '应调用 switchToChinese');
        assert.strictEqual(adapter.calls.en, 0, '不应切英文');
        assert.strictEqual(controller.getCurrentMode(), 'zh');
    });

    test('字符串 → 不切换（方案A：只在注释切换）', async () => {
        const { adapter, controller } = build({ ast: { match: true, type: 'string' } });
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(50);
        assert.strictEqual(adapter.calls.zh, 0);
        assert.strictEqual(adapter.calls.en, 0);
        assert.strictEqual(controller.getCurrentMode(), 'en', '字符串不应改变模式');
    });

    test('代码 + 中文态 → 切换到英文', async () => {
        const { adapter, controller } = build({ ast: { match: true, type: 'comment' } });
        await controller.analyzeAndSwitch(makeEditor('typescript', 0));
        await sleep(50);
        assert.strictEqual(controller.getCurrentMode(), 'zh');
        // 换到代码上下文（match=false）
        const b2 = build({ ast: { match: false, type: null } });
        b2.controller.updateStatusBar('zh'); // 置于中文态
        await b2.controller.analyzeAndSwitch(makeEditor('typescript', 3));
        await sleep(50);
        assert.strictEqual(b2.adapter.calls.en, 1, '应切回英文');
        assert.strictEqual(b2.controller.getCurrentMode(), 'en');
        void adapter;
    });

    test('fast 路径命中 → 直接切换且不触发 AST', async () => {
        const { adapter, analyzer, controller } = build({ fast: true });
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(50);
        assert.strictEqual(adapter.calls.zh, 1);
        assert.strictEqual(analyzer.stats.astCalled, 0, 'fast=true 不应再走 AST');
    });

    test('已处于目标模式 → 不重复切换', async () => {
        const { controller, adapter } = build({ ast: { match: true, type: 'comment' } });
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(50);
        assert.strictEqual(adapter.calls.zh, 1);
        await controller.analyzeAndSwitch(makeEditor('typescript', 1)); // 换行，仍是注释
        await sleep(50);
        assert.strictEqual(adapter.calls.zh, 1, '已是中文不应再次切换');
    });

    test('manualOverride 同行 → 暂停分析', async () => {
        const { analyzer, controller, tracker } = build({ manualOverride: true, ast: { match: true, type: 'comment' } });
        tracker.state.lastLine = 0; // 与光标同行
        await controller.analyzeAndSwitch(makeEditor('typescript', 0));
        await sleep(50);
        assert.strictEqual(analyzer.stats.fastCalled, 0, 'override 同行应提前返回，不分析');
    });

    test('manualOverride 换行 → 恢复分析', async () => {
        const { analyzer, controller, tracker } = build({ manualOverride: true, ast: { match: true, type: 'comment' } });
        tracker.state.lastLine = 9; // 与光标不同行
        await controller.analyzeAndSwitch(makeEditor('typescript', 0));
        await sleep(50);
        assert.ok(analyzer.stats.fastCalled >= 1, '换行应恢复并分析');
        assert.strictEqual(tracker.state.manualOverride, false, '应已重置 override');
    });

    test('非代码文档（scheme）→ 直接忽略', async () => {
        const { analyzer, controller } = build();
        const editor = makeEditor();
        editor.document.uri.scheme = 'output';
        await controller.analyzeAndSwitch(editor);
        await sleep(30);
        assert.strictEqual(analyzer.stats.fastCalled, 0);
    });

    test('switchTo 消费 success：失败记 FAILED（DD2）', async () => {
        const { adapter, logger, controller } = build({ ast: { match: true, type: 'comment' } });
        adapter.calls.zhResult = { success: false, method: 'toggle' };
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(50);
        assert.ok(logger.lines.some((l) => l.includes('switch to zh FAILED')), '失败切换应记 FAILED 日志');
    });

    test('行级防抖：连续快速事件只分析一次', async () => {
        const { analyzer, controller } = build({ ast: { match: false, type: null } });
        controller.analyzeAndSwitch(makeEditor('typescript', 1));
        controller.analyzeAndSwitch(makeEditor('typescript', 2));
        controller.analyzeAndSwitch(makeEditor('typescript', 3));
        await sleep(60);
        assert.strictEqual(analyzer.stats.fastCalled, 1, '三次快速事件应合并为一次分析');
    });

    test('dispose 清理待执行防抖定时器', async () => {
        const { controller } = build();
        controller.analyzeAndSwitch(makeEditor());
        controller.dispose();
        await sleep(30);
        assert.ok(true, 'dispose 后不应再抛错');
    });

    // ---- 巡检 C3：分析器异常不得逸出为未处理 rejection ----
    test('AST 分析 reject → 记错误日志，不抛到进程', async () => {
        const { logger, controller } = build({ analyzer: makeThrowingAnalyzer('ast-reject') });
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(60);
        assert.ok(logger.lines.some((l) => l.includes('boom-ast')), '应以 ERROR 记录分析失败');
    });

    test('快路径同步抛错 → analyzeAndSwitch 不向外抛', async () => {
        const { logger, controller } = build({ analyzer: makeThrowingAnalyzer('fast-throw') });
        await controller.analyzeAndSwitch(makeEditor());
        await sleep(60);
        assert.ok(logger.lines.some((l) => l.includes('boom-fast')), '应以 ERROR 记录调度/分析失败');
    });

    // ---- 巡检 G：无判定能力的语言一律不干预（不得猜“是代码”然后抢切英文）----
    test('未映射语言（如 markdown）→ 不做任何切换、不分析', async () => {
        const { adapter, analyzer, controller } = build({ ast: { match: false, type: null }, supported: false });
        controller.updateStatusBar('zh'); // 置于中文态：若能“猜代码”就会切回英文
        await controller.analyzeAndSwitch(makeEditor('markdown', 4));
        await sleep(50);
        assert.strictEqual(adapter.calls.en, 0, '不得为了“回英文”而抢切用户正在写的中文');
        assert.strictEqual(adapter.calls.zh, 0);
        assert.strictEqual(analyzer.stats.fastCalled, 0, '不该走快路径');
        assert.strictEqual(analyzer.stats.astCalled, 0, '不该走 AST');
        assert.strictEqual(controller.getCurrentMode(), 'zh', '模式保持原样');
    });

    test('已映射语言仍正常处理（supports 不是全局短路）', async () => {
        const { adapter, controller } = build({ ast: { match: true, type: 'comment' } });
        await controller.analyzeAndSwitch(makeEditor('typescript', 4));
        await sleep(50);
        assert.strictEqual(adapter.calls.zh, 1);
    });

    test('全程无未处理 Promise rejection（C3 锁行为）', async () => {
        await sleep(20);
        assert.deepStrictEqual(unhandledRejections, [], `不应出现未处理 rejection：${unhandledRejections.join(' / ')}`);
    });

    for (const item of queue) {
        testCount++;
        try { await item.fn(); passCount++; console.log(`  ✅ ${item.name}`); }
        catch (e) { failCount++; console.log(`  ❌ ${item.name}`); console.log(`     ${e.message}`); }
    }

    console.log('\n═══════════════════════════════════════');
    console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
    console.log('═══════════════════════════════════════');
    process.exit(failCount > 0 ? 1 : 0);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });

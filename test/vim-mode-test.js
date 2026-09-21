/**
 * VimModeListener 行为测试 —— 针对【真实源码】
 *
 * 验证核心行为：在 Vim 模式下进入 Normal(n) 模式会自动切换输入法到英文。
 * 覆盖 vim.ts 的三条触发路径：
 *   1. selection 事件检测到光标样式 Line(Insert) → Block(Normal) → forceEnglish
 *   2. options(onDidChangeTextEditorOptions) 事件 Line → Block → forceEnglish
 *   3. auto-ime.escape 命令（Vim 里按 Esc）→ forceEnglish
 * 以及反向：
 *   4. Normal → Insert（Block → Line）应做上下文分析（analyzeAndSwitch），不强制英文
 *   5. 一直处于 Normal（Block → Block）不应重复强制切换、也不分析
 *
 * 用 esbuild 现场把真实的 controller + vim 监听器打包为内存模块并加载，
 * 注入可驱动的 mock vscode（捕获事件回调以便手动触发）与 fake adapter。
 *
 * 运行：node test/vim-mode-test.js（不依赖 dist / 网络 / 真实输入法）
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const REPO_ROOT = path.join(__dirname, '..');

// 光标样式枚举（与 VS Code API 保持一致）
const CursorStyle = { Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 };

// ============================================================
// 可驱动的 mock vscode
// ============================================================
const captured = { commands: {}, events: {}, window: {} };

function disposable() {
    return { dispose() {} };
}

const vscodeMock = {
    TextEditorCursorStyle: CursorStyle,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {
        constructor(id) {
            this.id = id;
        }
    },
    commands: {
        registerCommand(id, cb) {
            captured.commands[id] = cb;
            return disposable();
        },
        executeCommand() {
            return Promise.resolve();
        },
    },
    window: {
        get activeTextEditor() {
            return captured.window.activeTextEditor;
        },
        set activeTextEditor(v) {
            captured.window.activeTextEditor = v;
        },
        createStatusBarItem() {
            return { text: '', tooltip: '', backgroundColor: undefined, command: '', show() {}, dispose() {} };
        },
        onDidChangeActiveTextEditor(cb) {
            captured.events.activeEditor = cb;
            return disposable();
        },
        onDidChangeTextEditorSelection(cb) {
            captured.events.selection = cb;
            return disposable();
        },
        onDidChangeTextEditorOptions(cb) {
            captured.events.options = cb;
            return disposable();
        },
        onDidChangeWindowState(cb) {
            captured.events.windowState = cb;
            return disposable();
        },
    },
    workspace: {
        onDidChangeTextDocument(cb) {
            captured.events.document = cb;
            return disposable();
        },
    },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return origLoad.call(this, request, parent, isMain);
};

// ============================================================
// 加载真实源码：controller + VimModeListener
// ============================================================
function loadModules() {
    const result = esbuild.buildSync({
        stdin: {
            contents:
                `export { IMEController } from './src/core/controller';\n` +
                `export { VimModeListener } from './src/modes/vim';`,
            resolveDir: REPO_ROOT,
            loader: 'ts',
            sourcefile: 'vim-entry.ts',
        },
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        external: ['vscode'],
        logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const mod = { exports: {} };
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    fn(mod.exports, require, mod, path.join(REPO_ROOT, 'vim-entry.js'), REPO_ROOT);
    return mod.exports;
}

const { IMEController, VimModeListener } = loadModules();

// ============================================================
// fakes
// ============================================================
function makeAdapter() {
    const calls = { en: 0, zh: 0 };
    return {
        name: 'fake',
        calls,
        isReady: () => true,
        queryMode: () => 'en',
        switchToEnglish() {
            calls.en++;
            return { success: true, method: 'layout' };
        },
        switchToChinese() {
            calls.zh++;
            return { success: true, method: 'layout' };
        },
    };
}
function makeTracker() {
    const state = { manualOverride: false, lastLine: -1, autoSwitches: [] };
    return {
        state,
        startListening: async () => {},
        stopListening() {},
        setOnChangeCallback() {},
        syncState() {},
        queryMode: () => 'en',
        isManualOverride: () => state.manualOverride,
        markManualSwitch() {
            state.manualOverride = true;
        },
        resetManualOverride() {
            state.manualOverride = false;
        },
        isDifferentPosition: (line) => line !== state.lastLine,
        updatePosition(line) {
            state.lastLine = line;
        },
        notifyAutoSwitch(mode) {
            state.autoSwitches.push(mode);
        },
    };
}
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
function makeEditor(cursorStyle, languageId = 'typescript', line = 0) {
    return {
        document: {
            languageId,
            lineCount: 10,
            uri: { scheme: 'file', toString: () => 'file:///a.ts' },
            version: 1,
            getText: () => '',
            lineAt: () => ({ text: '' }),
            offsetAt: () => 0,
        },
        selections: [{ active: { line, character: 2 } }],
        options: { cursorStyle },
    };
}

// ============================================================
// 测试框架
// ============================================================
let testCount = 0,
    passCount = 0,
    failCount = 0;
const queue = [];
function test(name, fn) {
    queue.push({ name, fn });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一套 controller + 已注册的 VimModeListener，并重置 mock 捕获 */
function setup(initialCursorStyle = CursorStyle.Line) {
    captured.commands = {};
    captured.events = {};
    const adapter = makeAdapter();
    const tracker = makeTracker();
    const logger = makeLogger();
    const statusBar = { text: '', tooltip: '', backgroundColor: undefined, command: '', show() {}, dispose() {} };
    const controller = new IMEController(adapter, makeNoopAnalyzer(), tracker, statusBar, logger);
    controller.setVimMode(true);
    controller.setInsertModeCheck((editor) => editor.options.cursorStyle === CursorStyle.Line);

    const ctx = {
        analyzeCalls: 0,
        forceCalls: 0,
        analyzeAndSwitch(editor) {
            ctx.analyzeCalls++;
            return controller.analyzeAndSwitch(editor);
        },
        forceEnglish() {
            ctx.forceCalls++;
            controller.forceEnglish();
        },
        toggleIME() {},
        updateStatusBar(mode) {
            controller.updateStatusBar(mode);
        },
        logger,
    };

    const editor = makeEditor(initialCursorStyle);
    captured.window.activeTextEditor = editor;

    const listener = new VimModeListener(logger);
    const disposables = listener.register(ctx);

    return { adapter, tracker, logger, controller, ctx, editor, listener, disposables };
}

function makeNoopAnalyzer() {
    const stats = { fastCalled: 0, astCalled: 0 };
    return {
        stats,
        init() {},
        dispose() {},
        isCursorInCommentFast() {
            stats.fastCalled++;
            return null;
        },
        async isCursorInCommentOrString() {
            stats.astCalled++;
            return { match: false, type: null };
        },
    };
}

async function run() {
    console.log('═══════════════════════════════════════');
    console.log('  VimModeListener 行为测试（真实源码）');
    console.log('  重点：进入 Normal(n) 模式自动切英文');
    console.log('═══════════════════════════════════════\n');

    test('注册时应捕获全部事件与 escape 命令', () => {
        const { ctx } = setup();
        assert.ok(captured.events.selection, '应注册 onDidChangeTextEditorSelection');
        assert.ok(captured.events.options, '应注册 onDidChangeTextEditorOptions');
        assert.ok(captured.commands['auto-ime.escape'], '应注册 auto-ime.escape 命令');
        void ctx;
    });

    test('Insert→Normal(selection 事件 Line→Block) → 自动 forceEnglish 切英文', async () => {
        const { adapter, ctx, editor } = setup(CursorStyle.Line);
        // 初始英文态
        assert.strictEqual(adapter.calls.en, 0);
        // 模拟从插入模式退回普通模式：光标样式变 Block 并触发 selection 事件
        editor.options.cursorStyle = CursorStyle.Block;
        captured.events.selection({ textEditor: editor });
        await sleep(20);
        assert.strictEqual(ctx.forceCalls, 1, 'Insert→Normal 应调用 forceEnglish 一次');
        assert.strictEqual(adapter.calls.en, 1, '应真实调用 adapter.switchToEnglish');
        assert.ok(adapter.calls.zh === 0, 'Normal 切换不应切中文');
    });

    test('Insert→Normal(options 事件 Line→Block) → 自动 forceEnglish 切英文', async () => {
        const { adapter, ctx, editor } = setup(CursorStyle.Line);
        editor.options.cursorStyle = CursorStyle.Block;
        captured.events.options({ textEditor: editor });
        await sleep(20);
        assert.strictEqual(ctx.forceCalls, 1, 'options 事件 Insert→Normal 应调用 forceEnglish');
        assert.strictEqual(adapter.calls.en, 1, '应调用 adapter.switchToEnglish');
    });

    test('Vim 里按 Esc(auto-ime.escape 命令) → forceEnglish 切英文', async () => {
        const { adapter, ctx } = setup(CursorStyle.Line);
        captured.commands['auto-ime.escape']();
        await sleep(20);
        assert.strictEqual(ctx.forceCalls, 1, 'escape 命令应调用 forceEnglish');
        assert.strictEqual(adapter.calls.en, 1, 'escape 应真实切换到英文');
    });

    test('Normal→Insert(Block→Line) → 做上下文分析而非强制英文', async () => {
        const { adapter, ctx, editor } = setup(CursorStyle.Block);
        // 注册时初始为 Block(Normal)，lastCursorStyle=Block 且已启动探测。
        const enBefore = adapter.calls.en;
        editor.options.cursorStyle = CursorStyle.Line;
        captured.events.options({ textEditor: editor });
        await sleep(60); // 让防抖 analyzeAndSwitch(10ms) 落地
        assert.ok(ctx.analyzeCalls >= 1, '进入 Insert 应触发 analyzeAndSwitch');
        assert.ok(adapter.calls.en <= enBefore + 1, 'Normal→Insert 不应额外强制英文');
    });

    test('一直处于 Normal(Block→Block) → 不重复强制英文也不分析', async () => {
        const { adapter, ctx, editor } = setup(CursorStyle.Line);
        // 先 Insert→Normal 一次
        editor.options.cursorStyle = CursorStyle.Block;
        captured.events.selection({ textEditor: editor });
        await sleep(10);
        const forceAfterFirst = ctx.forceCalls;
        const analyzeAfterFirst = ctx.analyzeCalls;
        const enAfterFirst = adapter.calls.en;
        // 再触发一次 Block→Block 的 selection 事件（仍在 Normal）
        captured.events.selection({ textEditor: editor });
        await sleep(20);
        assert.strictEqual(ctx.forceCalls, forceAfterFirst, 'Block→Block 不应再次 forceEnglish');
        assert.strictEqual(ctx.analyzeCalls, analyzeAfterFirst, 'Normal 态 selection 不应分析切换');
        assert.strictEqual(adapter.calls.en, enAfterFirst, '不应重复切换英文');
    });

    test('dispose 会清理模式探测定时器（不泄漏 interval）', async () => {
        const { listener, disposables } = setup(CursorStyle.Block);
        disposables.forEach((d) => d.dispose());
        listener.dispose();
        await sleep(30);
        assert.ok(true, 'dispose 后不应抛错');
    });

    for (const item of queue) {
        testCount++;
        try {
            await item.fn();
            passCount++;
            console.log(`  ✅ ${item.name}`);
        } catch (e) {
            failCount++;
            console.log(`  ❌ ${item.name}`);
            console.log(`     ${e.message}`);
        }
    }

    console.log('\n═══════════════════════════════════════');
    console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
    console.log('═══════════════════════════════════════');
    process.exit(failCount > 0 ? 1 : 0);
}

run().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});

/**
 * Mock 测试 - Windows 单键盘（IME 切换热键）策略
 *
 * 背景：原「TSF compartment 持久化管道」方案实测无效（从扩展宿主进程写
 * GUID_COMPARTMENT_KEYBOARD_OPENCLOSE 全局 compartment 不会改变前台应用的中英状态，
 * 该状态是线程/应用级、且宿主与渲染进程分离）。已整体移除，改为向前台窗口注入 IME
 * 切换热键（Shift / Ctrl+Space），让 IME 自己翻转。
 *
 * 拦截 Module._load 注入 mock 的 koffi / vscode，现场打包并驱动真实的
 * WindowsAdapter，验证：
 *   - 单键盘分支（只有中文布局）走热键切换而不是报错
 *   - 双键盘默认行为完全不变（不注入热键）
 *   - 切换是同步的、内部跟踪目标状态、重复切换 skip
 *   - toggleKey 配置（shift / ctrl-space）影响注入的按键
 *   - 热键注入失败时同步返回失败、不抛异常
 * 最后再对正式构建产物 dist/extension.js 做关键代码断言。
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const REPO_ROOT = path.join(__dirname, '..');

// ============================================================
// Mock 状态
// ============================================================
const mockState = {
    installedLayouts: [1033, 2052],
    currentLangId: 1033,
    foregroundHwnd: 0x00010001n,
    strategy: 'auto',          // auto-ime.windows.strategy
    toggleKey: 'shift',        // auto-ime.windows.toggleKey
    logLines: [],
    keybdCalls: [],            // 记录 keybd_event 调用
    failToggle: false,
};

function resetMock() {
    mockState.installedLayouts = [1033, 2052];
    mockState.currentLangId = 1033;
    mockState.foregroundHwnd = 0x00010001n;
    mockState.strategy = 'auto';
    mockState.toggleKey = 'shift';
    mockState.logLines = [];
    mockState.keybdCalls = [];
    mockState.failToggle = false;
}

function createLogger() {
    return {
        debug: (m) => mockState.logLines.push(`DEBUG ${m}`),
        info: (m) => mockState.logLines.push(`INFO ${m}`),
        warn: (m) => mockState.logLines.push(`WARN ${m}`),
        error: (m) => mockState.logLines.push(`ERROR ${m}`),
    };
}

function logged(substr) {
    return mockState.logLines.some((l) => l.includes(substr));
}

// ============================================================
// Mock koffi（只覆盖 Windows 适配器 / 热键切换用到的函数）
// ============================================================
function createMockKoffi() {
    const user32Funcs = {
        'HWND __stdcall GetForegroundWindow()': () => mockState.foregroundHwnd,
        'DWORD __stdcall GetWindowThreadProcessId(HWND, _Out_ DWORD*)': (hwnd, outPid) => {
            if (Array.isArray(outPid)) outPid[0] = 1234;
            return 5678;
        },
        'HKL __stdcall GetKeyboardLayout(DWORD)': () => BigInt(mockState.currentLangId),
        'int __stdcall GetKeyboardLayoutList(int, void*)': (count, buf) => {
            const layouts = mockState.installedLayouts;
            if (count === 0) return layouts.length;
            if (buf && Buffer.isBuffer(buf)) {
                for (let i = 0; i < layouts.length; i++) buf.writeBigUInt64LE(BigInt(layouts[i]), i * 8);
            }
            return layouts.length;
        },
        'DWORD __stdcall GetCurrentThreadId()': () => 9999,
        'BOOL __stdcall AttachThreadInput(DWORD, DWORD, BOOL)': () => 1,
        'BOOL __stdcall PostMessageW(HWND, UINT, WPARAM, LPARAM)': (hwnd, msg, w, l) => {
            mockState.currentLangId = Number(l);
            return 1;
        },
        // 单键盘热键注入：记录按键，可模拟失败
        'void __stdcall keybd_event(uint8_t, uint8_t, uint32_t, uint64)': (vk, scan, flags, extra) => {
            if (mockState.failToggle) throw new Error('keybd_event simulated failure');
            mockState.keybdCalls.push({ vk: Number(vk), scan: Number(scan), flags: Number(flags) });
        },
    };

    function createMockDll(funcDefs) {
        return {
            func: (sig) => funcDefs[sig] || (() => 0)
        };
    }

    return {
        load: (dllName) => {
            if (dllName === 'user32.dll') return createMockDll(user32Funcs);
            return createMockDll({});
        },
        struct: (name, fields) => ({ name, fields }),
        alias: (name, base) => ({ name, base }),
        pointer: (name, base) => ({ name, base }),
        opaque: () => ({}),
        array: (type, len) => ({ type, len }),
        proto: (name, ret, params) => ({ name, ret, params }),
    };
}

// ============================================================
// 注入 mock
// ============================================================
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'koffi' || request === 'vscode') return request;
    return originalResolve.call(this, request, parent, isMain, options);
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'koffi') {
        const k = createMockKoffi();
        return { default: k, ...k };
    }
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, def) => {
                        if (section === 'auto-ime.windows' && key === 'strategy') return mockState.strategy;
                        if (section === 'auto-ime.windows' && key === 'toggleKey') return mockState.toggleKey;
                        return def;
                    },
                }),
            },
            StatusBarAlignment: { Left: 1 },
            TextEditorCursorStyle: { Block: 4, Line: 1 },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

// ============================================================
// 现场打包被测模块（内存中进行，不落盘）
// ============================================================
function buildTestModule() {
    const result = esbuild.buildSync({
        stdin: {
            contents: `export { WindowsAdapter } from './src/platforms/windows/adapter';`,
            resolveDir: REPO_ROOT,
            loader: 'ts',
            sourcefile: 'single-kb-test-entry.ts',
        },
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        external: ['vscode', 'koffi'],
        logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const mod = { exports: {} };
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    fn(mod.exports, require, mod, path.join(REPO_ROOT, 'single-kb-test-entry.js'), REPO_ROOT);
    return mod.exports;
}

const testModule = buildTestModule();
const { WindowsAdapter } = testModule;

// ============================================================
// 测试框架（串行执行）
// ============================================================
let testCount = 0, passCount = 0, failCount = 0;
const queue = [];

function section(title) { queue.push({ section: title }); }
function test(name, fn) { queue.push({ name, fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQueue() {
    for (const item of queue) {
        if (item.section) { console.log(`\n${item.section}`); continue; }
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

// ============================================================
// 正式构建产物（dist/extension.js）断言
// ============================================================
console.log('═══════════════════════════════════════');
console.log('  Mock 单键盘（IME 切换热键）测试');
console.log('═══════════════════════════════════════');

const distPath = path.join(REPO_ROOT, 'dist', 'extension.js');
if (!fs.existsSync(distPath)) {
    esbuild.buildSync({
        entryPoints: [path.join(REPO_ROOT, 'src', 'extension.ts')],
        bundle: true,
        outfile: distPath,
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        external: ['vscode', 'x11', 'koffi', 'debug'],
        logLevel: 'silent',
    });
}
const bundleSrc = fs.readFileSync(distPath, 'utf-8');

section('📦 测试 1: 构建产物包含单键盘热键切换机制');

test('bundle 包含 SingleKeyboardStrategy 与 sendImeToggle', () => {
    assert.ok(bundleSrc.includes('SingleKeyboardStrategy'), '应包含 SingleKeyboardStrategy');
    assert.ok(bundleSrc.includes('sendImeToggle'), '应包含 sendImeToggle');
});

test('bundle 通过 keybd_event 注入切换热键', () => {
    assert.ok(bundleSrc.includes('keybd_event'), '应调用 keybd_event');
    assert.ok(bundleSrc.includes('VK_SHIFT'), '应包含 Shift 键');
    assert.ok(bundleSrc.includes('VK_CONTROL'), '应包含 Ctrl 键');
});

test('bundle 包含 auto-ime.windows.toggleKey 配置读取', () => {
    assert.ok(bundleSrc.includes('toggleKey'), '应读取 toggleKey 配置');
    assert.ok(bundleSrc.includes('ctrl-space'), '应支持 ctrl-space 取值');
});

test('bundle 不再包含已废弃的 TSF compartment 管道', () => {
    assert.ok(!bundleSrc.includes('TSFPipe'), '不应再包含 TSFPipe 类');
    assert.ok(!bundleSrc.includes('[Console]::In.ReadLine'), '不应再保留 PowerShell 管道');
    assert.ok(!bundleSrc.includes('58273AAD'), '不应再包含 TSF compartment GUID');
    assert.ok(!bundleSrc.includes('529A9E6B'), '不应再包含 CLSID_TF_ThreadMgr');
});

// ---- 测试 2: 单键盘分支 ----
section('📦 测试 2: 单键盘（只有中文布局）走热键切换');

test('只有 zhLangId 时 adapter 就绪且选择热键切换策略', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    assert.strictEqual(adapter.isReady(), true, '应就绪');
    assert.ok(logged('Strategy: single-keyboard toggle'), '日志应记录 single-keyboard toggle');
    assert.ok(!logged('not yet implemented'), '不应再出现 TODO 降级日志');
    adapter.dispose();
});

test('switchToChinese 同步返回 method=toggle 并注入 Shift', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    const r = adapter.switchToChinese();
    assert.strictEqual(r.success, true, '应报告成功');
    assert.strictEqual(r.method, 'toggle', `method 应为 toggle，实际 ${r.method}`);
    assert.strictEqual(typeof r.elapsedMs, 'number', '应带耗时');
    assert.ok(r.elapsedMs < 50, `同步路径不应阻塞，实际 ${r.elapsedMs}ms`);
    assert.strictEqual(adapter.queryMode(), 'zh', 'queryMode 应返回内部目标状态 zh');
    // Shift 切换 = 一次 down + 一次 up
    assert.strictEqual(mockState.keybdCalls.length, 2, `应注入 2 次按键，实际 ${mockState.keybdCalls.length}`);
    assert.strictEqual(mockState.keybdCalls[0].vk, 0x10, '第一次应为 Shift down');
    assert.strictEqual(mockState.keybdCalls[0].flags, 0, 'down');
    assert.strictEqual(mockState.keybdCalls[1].flags, 2, 'up');
    adapter.dispose();
});

test('重复切换到同一模式返回 skip 且不再注入按键', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    adapter.switchToChinese();
    const before = mockState.keybdCalls.length;
    const again = adapter.switchToChinese();
    assert.strictEqual(again.method, 'skip', '重复切换应 skip');
    assert.strictEqual(mockState.keybdCalls.length, before, 'skip 不应注入新按键');
    adapter.dispose();
});

test('英文↔中文双向切换每次注入一次热键', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    adapter.switchToChinese();
    const c1 = mockState.keybdCalls.length;
    adapter.switchToEnglish();
    assert.strictEqual(adapter.queryMode(), 'en', '应切到 en');
    assert.strictEqual(mockState.keybdCalls.length, c1 + 2, 'en 切换应再注入 2 次按键');
    adapter.switchToChinese();
    assert.strictEqual(adapter.queryMode(), 'zh', '应切回 zh');
    adapter.dispose();
});

test('toggleKey=ctrl-space 时注入 Ctrl+Space', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    mockState.toggleKey = 'ctrl-space';
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    adapter.switchToEnglish();
    const vks = mockState.keybdCalls.map((c) => c.vk);
    assert.deepStrictEqual(vks, [0x11, 0x20, 0x20, 0x11], `应为 Ctrl down/Space down/Space up/Ctrl up，实际 ${JSON.stringify(vks)}`);
    adapter.dispose();
});

test('热键注入失败时同步返回失败、不抛异常、不污染状态', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    mockState.failToggle = true;
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    let result = null, threw = false;
    try {
        result = adapter.switchToChinese();
    } catch (e) {
        threw = true;
    }

    assert.strictEqual(threw, false, '不应抛异常');
    assert.strictEqual(result.success, false, '注入失败应返回失败');
    assert.strictEqual(result.method, 'none', 'method 应为 none');
    assert.strictEqual(adapter.queryMode(), 'en', '失败时不应更新目标状态');
    assert.ok(logged('toggle failed'), '应记录失败日志');
    adapter.dispose();
});

// ---- 测试 3: 双键盘默认行为不变 ----
section('📦 测试 3: 双键盘默认行为不受影响');

test('双键盘默认走 layout 且不注入热键', () => {
    resetMock();
    mockState.installedLayouts = [1033, 2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    assert.ok(logged('Strategy: dual-keyboard'), '应仍选择 dual-keyboard');
    const r = adapter.switchToChinese();
    assert.strictEqual(r.method, 'layout', '应仍使用 layout 切换');
    assert.strictEqual(mockState.keybdCalls.length, 0, '双键盘不应注入热键');
    adapter.dispose();
});

// ---- 测试 4: 显式配置 ----
section('📦 测试 4: auto-ime.windows.strategy 强制指定');

test('strategy=single-keyboard 时即使有双键盘也走热键切换', () => {
    resetMock();
    mockState.installedLayouts = [1033, 2052];
    mockState.strategy = 'single-keyboard';
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    assert.ok(logged('Strategy: single-keyboard toggle'), '应选择 single-keyboard toggle');
    const r = adapter.switchToEnglish();
    assert.strictEqual(r.method, 'toggle', `method 应为 toggle，实际 ${r.method}`);
    assert.strictEqual(mockState.keybdCalls.length, 2, '应注入热键');
    adapter.dispose();
});

test('strategy=dual-keyboard 缺英语布局时降级为热键切换并记录错误', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    mockState.strategy = 'dual-keyboard';
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    assert.ok(logged('English keyboard layout missing'), '应记录降级原因');
    assert.ok(logged('Strategy: single-keyboard toggle'), '应降级到 single-keyboard toggle');
    adapter.dispose();
});

// ---- 测试 5: 无读取能力说明 ----
section('📦 测试 5: 无跨进程读取（诚实说明）');

test('startListening 返回 false（无事件驱动读取）', async () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());

    const eventDriven = await adapter.startListening(() => {});
    assert.strictEqual(eventDriven, false, '应告知无法事件驱动监听（无跨进程读取）');
    adapter.dispose();
});

test('syncState 不抛异常（无跨进程读取，状态保持跟踪）', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());
    adapter.switchToChinese();
    adapter.syncState();
    assert.strictEqual(adapter.queryMode(), 'zh', 'syncState 后状态保持跟踪值');
    adapter.dispose();
});

// ---- 测试 6: 资源释放 ----
section('📦 测试 6: dispose 幂等');

test('dispose 幂等（重复调用不抛异常）', () => {
    resetMock();
    mockState.installedLayouts = [2052];
    const adapter = new WindowsAdapter();
    adapter.init(createLogger());
    adapter.dispose();
    adapter.dispose();
    assert.ok(true, '重复 dispose 安全');
});

// ---- 汇总 ----
runQueue();

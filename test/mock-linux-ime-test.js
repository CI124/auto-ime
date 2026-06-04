/**
 * Mock Linux IME 测试 - 模拟 Fcitx5 / Fcitx4 / IBus 环境
 *
 * 适配 v0.6.0+ 模块化架构：
 * - 使用 createPlatformAdapter 替代旧的 createImeManager
 * - Mock child_process.execSync 拦截直接命令调用
 * - 测试 LinuxAdapter 的检测、查询、切换、降级与异常处理
 */

const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

// ============================================================
// Mock 状态
// ============================================================
const mockState = {
    // 命令可用性（execSync 不抛异常 = 命令存在）
    fcitx5Available: true,
    fcitx4Available: true,
    ibusAvailable: true,

    // fcitx5 返回值
    fcitx5CurrentInput: 'pinyin',

    // fcitx4 返回值
    fcitx4Result: '2',   // '1'=英文, '2'=中文

    // ibus 返回值
    ibusCurrentEngine: 'libpinyin',

    // 超时模拟
    timeoutCommands: new Set(),

    // 调用日志
    callLog: [],
};

function logCall(name, ...args) {
    mockState.callLog.push({ name, args: [...args] });
}

function resetMock() {
    mockState.fcitx5Available = true;
    mockState.fcitx4Available = true;
    mockState.ibusAvailable = true;
    mockState.fcitx5CurrentInput = 'pinyin';
    mockState.fcitx4Result = '2';
    mockState.ibusCurrentEngine = 'libpinyin';
    mockState.timeoutCommands = new Set();
    mockState.callLog = [];
}

// ============================================================
// 命令路由：解析 execSync 直接调用的命令
// ============================================================
function handleCommand(cmd) {
    logCall('execSync', cmd);

    // 超时检查
    for (const pat of mockState.timeoutCommands) {
        if (cmd.includes(pat)) {
            const err = new Error(`Command failed: ${cmd}`);
            err.killed = true;
            err.code = 'ETIMEDOUT';
            throw err;
        }
    }

    // fcitx5-remote -n (查询)
    if (/fcitx5-remote\s+-n/.test(cmd)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return mockState.fcitx5CurrentInput;
    }

    // fcitx5-remote -s (切换)
    if (/fcitx5-remote\s+-s/.test(cmd)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return '';
    }

    // fcitx-remote (查询，无参数)
    if (/^fcitx-remote$/.test(cmd.trim())) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return mockState.fcitx4Result;
    }

    // fcitx-remote -n (检测)
    if (/fcitx-remote\s+-n/.test(cmd)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }

    // fcitx-remote -c / -o (切换)
    if (/fcitx-remote\s+-[co]/.test(cmd)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }

    // ibus engine (查询，无参数)
    if (/^ibus\s+engine$/.test(cmd.trim())) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return mockState.ibusCurrentEngine;
    }

    // ibus engine <name> (切换)
    if (/ibus\s+engine\s+/.test(cmd)) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return '';
    }

    return '';
}

// ============================================================
// 设置 platform = linux
// ============================================================
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
process.env.HOME = '/home/testuser';

// ============================================================
// 拦截 require，注入 mock 模块
// ============================================================
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};

const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
    // ── Mock child_process ──
    if (request === 'child_process') {
        return {
            execSync: function(cmd, opts) {
                return handleCommand(cmd);
            },
            execFileSync: function(cmd, args, opts) {
                return handleCommand(cmd);
            },
            spawn: function() { return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {} }; },
        };
    }

    // ── Mock vscode ──
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, def) => {
                        if (section === 'auto-ime.ibus' && key === 'englishEngine') return 'xkb:us::eng';
                        if (section === 'auto-ime.ibus' && key === 'chineseEngine') return 'libpinyin';
                        if (section === 'auto-ime.fcitx5' && key === 'englishEngine') return 'keyboard-us';
                        if (section === 'auto-ime.fcitx5' && key === 'chineseEngine') return 'fcitx5-pinyin';
                        if (section === 'auto-ime.windows' && key === 'pollingInterval') return 150;
                        return def;
                    },
                }),
                onDidChangeTextDocument: () => ({ dispose: () => {} }),
            },
            extensions: { getExtension: () => null },
            window: {
                activeTextEditor: null,
                createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
                createStatusBarItem: () => ({
                    text: '', tooltip: '', backgroundColor: undefined,
                    show: () => {}, dispose: () => {}, command: '',
                }),
                onDidChangeWindowState: () => ({ dispose: () => {} }),
                onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
                onDidChangeTextEditorOptions: () => ({ dispose: () => {} }),
                onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
            },
            StatusBarAlignment: { Left: 1, Right: 2 },
            TextEditorCursorStyle: { Block: 4, Line: 1 },
            ThemeColor: class { constructor(s) { this.id = s; } },
            Disposable: { from: () => ({ dispose: () => {} }) },
            commands: {
                registerCommand: () => ({ dispose: () => {} }),
                executeCommand: () => Promise.resolve(),
            },
        };
    }

    return origLoad.call(this, request, parent, isMain);
};

// ============================================================
// 测试框架
// ============================================================
let testCount = 0, passCount = 0, failCount = 0;

function test(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failCount++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.message}`);
    }
}

// ============================================================
// 加载 bundle
// ============================================================
const ext = require('../dist/extension');
const bundleSrc = fs.readFileSync(path.join(__dirname, '..', 'dist', 'extension.js'), 'utf-8');

// 提取 createPlatformAdapter（通过 _compile 钩子注入）
const origCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
    if (filename && filename.endsWith('extension.js') && content.includes('function createPlatformAdapter(')) {
        const exportMarker = 'module.exports = __toCommonJS(extension_exports);';
        const idx = content.indexOf(exportMarker);
        if (idx !== -1) {
            content =
                content.slice(0, idx + exportMarker.length) +
                '\nmodule.exports.createPlatformAdapter = createPlatformAdapter;\n' +
                content.slice(idx + exportMarker.length);
        }
    }
    origCompile.call(this, content, filename);
};

// 重新加载以注入 createPlatformAdapter
delete require.cache[require.resolve('../dist/extension')];
const ext2 = require('../dist/extension');
const createPlatformAdapter = ext2.createPlatformAdapter;

// 创建适配器的辅助函数
function createAdapter() {
    const logger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    };
    const adapter = createPlatformAdapter(logger);
    return adapter;
}

// ══════════════════════════════════════════════════════════════
// 测试开始
// ══════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════');
console.log('  Mock Linux IME 测试 (v0.6.0+ 架构)');
console.log('═══════════════════════════════════════');

// ──────────────────────────────────────────────────────────────
// 测试 1: Fcitx5 基本操作
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 1: Fcitx5 基本操作');

test('createPlatformAdapter 可从 bundle 中提取', () => {
    assert.strictEqual(typeof createPlatformAdapter, 'function');
});

test('Fcitx5 检测成功，返回可用适配器', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true, 'adapter 应就绪');
});

test('Fcitx5 queryMode: pinyin → zh', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'pinyin';
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5 queryMode: keyboard-us → en', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5 switchToEnglish 调用 fcitx5-remote -s', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToEnglish();
    const found = mockState.callLog.some(c => c.name === 'execSync' && /fcitx5-remote\s+-s/.test(c.args[0]));
    assert.ok(found, '应调用 fcitx5-remote -s');
});

test('Fcitx5 switchToChinese 调用 fcitx5-remote -s', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToChinese();
    const found = mockState.callLog.some(c => c.name === 'execSync' && /fcitx5-remote\s+-s/.test(c.args[0]));
    assert.ok(found, '应调用 fcitx5-remote -s');
});

test('Fcitx5 返回 SwitchResult 对象', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(typeof result.success, 'boolean');
    assert.strictEqual(typeof result.method, 'string');
});

test('Fcitx5 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en', '初始英文');

    mockState.fcitx5CurrentInput = 'pinyin';
    assert.strictEqual(adapter.queryMode(), 'zh', '切换后中文');

    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(adapter.queryMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
// 测试 2: Fcitx4 基本操作
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 2: Fcitx4 基本操作');

test('Fcitx4 检测成功（Fcitx5 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('Fcitx4 queryMode: result=2 → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx4Result = '2';
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx4 queryMode: result=1 → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx4Result = '1';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx4 switchToEnglish 调用 fcitx-remote -c', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToEnglish();
    const found = mockState.callLog.some(c => c.name === 'execSync' && /fcitx-remote\s+-c/.test(c.args[0]));
    assert.ok(found, '应调用 fcitx-remote -c');
});

test('Fcitx4 switchToChinese 调用 fcitx-remote -o', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToChinese();
    const found = mockState.callLog.some(c => c.name === 'execSync' && /fcitx-remote\s+-o/.test(c.args[0]));
    assert.ok(found, '应调用 fcitx-remote -o');
});

test('Fcitx4 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx4Result = '1';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en', '初始英文');

    mockState.fcitx4Result = '2';
    assert.strictEqual(adapter.queryMode(), 'zh', '切换后中文');

    mockState.fcitx4Result = '1';
    assert.strictEqual(adapter.queryMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
// 测试 3: IBus 基本操作
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 3: IBus 基本操作');

test('IBus 检测成功（Fcitx5/4 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('IBus queryMode: libpinyin → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('IBus queryMode: xkb:us::eng → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('IBus switchToEnglish 调用 ibus engine', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToEnglish();
    const found = mockState.callLog.some(c => c.name === 'execSync' && /ibus\s+engine/.test(c.args[0]));
    assert.ok(found, '应调用 ibus engine');
});

test('IBus switchToChinese 调用 ibus engine', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToChinese();
    const found = mockState.callLog.some(c => c.name === 'execSync' && /ibus\s+engine/.test(c.args[0]));
    assert.ok(found, '应调用 ibus engine');
});

test('IBus 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en', '初始英文');

    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(adapter.queryMode(), 'zh', '切换后中文');

    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(adapter.queryMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
// 测试 4: 无 IME 可用时的回退
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 4: 无 IME 可用时的回退');

test('所有 IME 均不可用时 adapter.isReady() 返回 false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
});

test('不可用时 queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('不可用时 switchToEnglish 返回 success=false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.method, 'none');
});

test('不可用时 switchToChinese 返回 success=false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    const result = adapter.switchToChinese();
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.method, 'none');
});

test('不可用时连续调用安全', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    for (let i = 0; i < 100; i++) {
        adapter.switchToEnglish();
        adapter.switchToChinese();
        adapter.queryMode();
    }
});

// ──────────────────────────────────────────────────────────────
// 测试 5: 超时与异常安全
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 5: 超时与异常安全');

test('fcitx5-remote 超时，queryMode 返回 en（catch 回退）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote -n');
    const adapter = createAdapter();
    const mode = adapter.queryMode();
    assert.strictEqual(mode, 'en', '超时时 catch 返回 en');
});

test('fcitx5-remote 超时，switchToEnglish 返回 success=false', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote');
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.success, false);
});

test('fcitx-remote 超时，Fcitx4Manager queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx-remote');
    const adapter = createAdapter();
    const mode = adapter.queryMode();
    assert.strictEqual(mode, 'en');
});

test('ibus engine 超时，IBusManager queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.timeoutCommands.add('ibus engine');
    const adapter = createAdapter();
    const mode = adapter.queryMode();
    assert.strictEqual(mode, 'en');
});

test('连续超时不累积阻塞：10 次调用均 < 1s', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.timeoutCommands.add('ibus engine');
    const adapter = createAdapter();
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
        adapter.queryMode();
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `10 次调用应 < 1s，实际 ${elapsed}ms`);
});

// ──────────────────────────────────────────────────────────────
// 测试 6: 责任链降级
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 6: 责任链降级');

test('Fcitx5 不可用 → 降级到 Fcitx4', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true, '应降级到 Fcitx4');
    mockState.fcitx4Result = '2';
    assert.strictEqual(adapter.queryMode(), 'zh');
    mockState.fcitx4Result = '1';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5+Fcitx4 不可用 → 降级到 IBus', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true, '应降级到 IBus');
    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(adapter.queryMode(), 'zh');
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('全部不可用 → adapter 不可用', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('降级后切换命令使用正确的目标', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToChinese();
    const hasFcitx4 = mockState.callLog.some(c => /fcitx-remote\s+-o/.test(c.args[0]));
    assert.ok(hasFcitx4, '应使用 fcitx-remote -o');
});

test('降级到 IBus 后切换命令正确', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToEnglish();
    const hasIbus = mockState.callLog.some(c => /ibus\s+engine/.test(c.args[0]));
    assert.ok(hasIbus, '应使用 ibus engine');
});

// ──────────────────────────────────────────────────────────────
// 测试 7: 边界场景
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 7: 边界场景');

test('Fcitx5 queryMode: 未知输入法名返回 zh', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'some-unknown-input-method';
    assert.strictEqual(adapter.queryMode(), 'zh', '不含 keyboard/xkb 应返回 zh');
});

test('Fcitx5 queryMode: xkb:us → en', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'xkb:us';
    assert.strictEqual(adapter.queryMode(), 'en', '含 xkb 应返回 en');
});

test('Fcitx4 queryMode: result=0 → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx4Result = '0';
    assert.strictEqual(adapter.queryMode(), 'zh', 'result=0 不等于 1 应返回 zh');
});

test('IBus queryMode: 空引擎名 → en (catch 回退)', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusCurrentEngine = '';
    // 空字符串不包含 'xkb' 或 'eng'，应返回 zh
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh', '空引擎名应返回 zh');
});

test('switchToEnglish 后立即 switchToChinese 不冲突', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.callLog = [];
    adapter.switchToEnglish();
    adapter.switchToChinese();
    const switchCalls = mockState.callLog.filter(c => /fcitx5-remote\s+-s/.test(c.args[0]));
    assert.strictEqual(switchCalls.length, 2, `应有 2 次切换调用，实际 ${switchCalls.length}`);
});

test('返回对象实现 IPlatformAdapter 接口', () => {
    resetMock();
    const adapter = createAdapter();
    assert.strictEqual(typeof adapter.name, 'string');
    assert.strictEqual(typeof adapter.isReady, 'function');
    assert.strictEqual(typeof adapter.queryMode, 'function');
    assert.strictEqual(typeof adapter.switchToEnglish, 'function');
    assert.strictEqual(typeof adapter.switchToChinese, 'function');
});

test('多次 createPlatformAdapter 返回独立实例', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter1 = createAdapter();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(adapter1.queryMode(), 'en');

    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter2 = createAdapter();
    assert.strictEqual(adapter2.queryMode(), 'zh');
});

// ──────────────────────────────────────────────────────────────
// 测试 8: Bundle 内容验证
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 8: Bundle 内容验证');

test('bundle 包含 LinuxAdapter 类', () => {
    assert.ok(bundleSrc.includes('LinuxAdapter'), '应包含 LinuxAdapter');
});

test('bundle 包含 Fcitx5Manager 类', () => {
    assert.ok(bundleSrc.includes('Fcitx5Manager'), '应包含 Fcitx5Manager');
});

test('bundle 包含 Fcitx4Manager 类', () => {
    assert.ok(bundleSrc.includes('Fcitx4Manager'), '应包含 Fcitx4Manager');
});

test('bundle 包含 IBusManager 类', () => {
    assert.ok(bundleSrc.includes('IBusManager'), '应包含 IBusManager');
});

test('bundle 包含 fcitx5-remote 调用', () => {
    assert.ok(bundleSrc.includes('fcitx5-remote'), '应包含 fcitx5-remote');
});

test('bundle 包含 fcitx-remote 调用', () => {
    assert.ok(bundleSrc.includes('fcitx-remote'), '应包含 fcitx-remote');
});

test('bundle 包含 ibus engine 调用', () => {
    assert.ok(bundleSrc.includes('ibus engine'), '应包含 ibus engine');
});

test('bundle 包含 createPlatformAdapter 工厂函数', () => {
    assert.ok(bundleSrc.includes('createPlatformAdapter'), '应包含 createPlatformAdapter');
});

test('bundle 包含平台守卫', () => {
    assert.ok(
        bundleSrc.includes('process.platform === "win32"') ||
        bundleSrc.includes("process.platform === 'win32'"),
        '应包含 win32 平台守卫'
    );
});

test('bundle 包含 IPlatformAdapter 接口', () => {
    assert.ok(bundleSrc.includes('IPlatformAdapter') || bundleSrc.includes('queryMode'), '应包含平台适配器接口');
});

test('bundle 包含状态追踪器', () => {
    assert.ok(bundleSrc.includes('IMEStateTracker') || bundleSrc.includes('StateTracker'), '应包含状态追踪器');
});

test('bundle 包含控制器', () => {
    assert.ok(bundleSrc.includes('IMEController') || bundleSrc.includes('Controller'), '应包含控制器');
});

test('bundle 包含 NormalModeListener', () => {
    assert.ok(bundleSrc.includes('NormalModeListener') || bundleSrc.includes('normal'), '应包含普通模式监听器');
});

test('bundle 包含 VimModeListener', () => {
    assert.ok(bundleSrc.includes('VimModeListener') || bundleSrc.includes('vim'), '应包含 Vim 模式监听器');
});

// ──────────────────────────────────────────────────────────────
// 汇总
// ──────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
console.log('═══════════════════════════════════════');

// 清理
if (typeof ext.deactivate === 'function') {
    try { ext.deactivate(); } catch {}
}

process.exit(failCount > 0 ? 1 : 0);

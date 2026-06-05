/**
 * Mock Linux IME 测试 - 模拟 Fcitx5 / Fcitx4 / IBus 环境
 *
 * 适配 v0.6.0+ 模块化架构，业务逻辑与 v0.5.0 一致：
 * - Fcitx5: 读取 ~/.config/fcitx5/profile，精确匹配 englishTarget
 * - Fcitx4: exit code 查询（1=英文, 2=中文）
 * - IBus: 精确匹配配置的 englishEngine
 * - 检测: bash -c "command -v ..."
 * - 使用 execFileSync('bash', ['-c', ...]) 而非 execSync
 */

const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

// ============================================================
// Mock 状态
// ============================================================
const mockState = {
    fcitx5Available: true,
    fcitx4Available: true,
    ibusAvailable: true,

    fcitx5CurrentInput: 'pinyin',
    fcitx4ExitCode: 2,            // 1=英文, 2=中文
    ibusCurrentEngine: 'libpinyin',

    profileExists: true,
    profileContent: [
        '[Groups/0]',
        'Name=Default',
        'Default Layout=us',
        'DefaultIM=pinyin',
        '',
        '[Groups/0/Items/0]',
        'Name=keyboard-us',
        'Layout=',
        '',
        '[Groups/0/Items/1]',
        'Name=pinyin',
        'Layout=',
    ].join('\n'),

    timeoutCommands: new Set(),
    callLog: [],
    bashScripts: [],
};

function logCall(name, ...args) {
    mockState.callLog.push({ name, args: [...args] });
}

function resetMock() {
    mockState.fcitx5Available = true;
    mockState.fcitx4Available = true;
    mockState.ibusAvailable = true;
    mockState.fcitx5CurrentInput = 'pinyin';
    mockState.fcitx4ExitCode = 2;
    mockState.ibusCurrentEngine = 'libpinyin';
    mockState.profileExists = true;
    mockState.profileContent = [
        '[Groups/0]',
        'Name=Default',
        'Default Layout=us',
        'DefaultIM=pinyin',
        '',
        '[Groups/0/Items/0]',
        'Name=keyboard-us',
        'Layout=',
        '',
        '[Groups/0/Items/1]',
        'Name=pinyin',
        'Layout=',
    ].join('\n');
    mockState.timeoutCommands = new Set();
    mockState.callLog = [];
    mockState.bashScripts = [];
}

// ============================================================
// 命令路由：解析 bash -c "script" 中的命令
// ============================================================
function handleBashScript(script) {
    mockState.bashScripts.push(script);

    // 检测脚本: command -v ...
    if (/command -v fcitx5-remote/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        if (!mockState.profileExists) throw new Error('fcitx5 profile: not found');
        return '';
    }
    if (/command -v fcitx-remote/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }
    if (/command -v ibus/.test(script)) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return '';
    }

    // fcitx5-remote -n (查询)
    if (/fcitx5-remote\s+-n/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return mockState.fcitx5CurrentInput;
    }

    // fcitx5-remote -s (切换)
    if (/fcitx5-remote\s+-s/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return '';
    }

    // fcitx-remote 查询（echo $? 获取退出码）
    if (/fcitx-remote/.test(script) && /echo\s+\$\?/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return String(mockState.fcitx4ExitCode);
    }

    // fcitx-remote -c / -o (切换)
    if (/fcitx-remote\s/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }

    // ibus engine 查询（无参数）
    if (/ibus\s+engine\s*$/.test(script.trim())) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return mockState.ibusCurrentEngine;
    }

    // ibus engine <name> (切换)
    if (/ibus\s+engine\s+/.test(script)) {
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
// 覆盖 fs.existsSync / fs.readFileSync（模拟 profile 文件）
// ============================================================
const origExistsSync = fs.existsSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);

fs.existsSync = function(p) {
    if (typeof p === 'string' && p.includes('fcitx5') && p.includes('profile')) {
        return mockState.profileExists;
    }
    return origExistsSync(p);
};

fs.readFileSync = function(p, encoding) {
    if (typeof p === 'string' && p.includes('fcitx5') && p.includes('profile')) {
        return mockState.profileContent;
    }
    return origReadFileSync(p, encoding);
};

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
    // Mock child_process
    if (request === 'child_process') {
        return {
            execSync: function(cmd, opts) {
                logCall('execSync', cmd);
                for (const pat of mockState.timeoutCommands) {
                    if (cmd.includes(pat)) throw new Error(`Command failed: ${cmd}`);
                }
                return handleBashScript(cmd);
            },
            execFileSync: function(cmd, args, opts) {
                logCall('execFileSync', cmd, ...(args || []));
                if (cmd === 'bash' && Array.isArray(args) && args[0] === '-c') {
                    const script = args[1];
                    for (const pat of mockState.timeoutCommands) {
                        if (script.includes(pat)) throw new Error(`Command failed: bash -c "${script}"`);
                    }
                    return handleBashScript(script);
                }
                return '';
            },
            spawn: function() { return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {} }; },
        };
    }

    // Mock vscode
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

// 提取 createPlatformAdapter
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

delete require.cache[require.resolve('../dist/extension')];
const ext2 = require('../dist/extension');
const createPlatformAdapter = ext2.createPlatformAdapter;

function createAdapter() {
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    return createPlatformAdapter(logger);
}

// ══════════════════════════════════════════════════════════════
console.log('═══════════════════════════════════════');
console.log('  Mock Linux IME 测试 (v0.6.0+ 架构, v0.5.0 业务逻辑)');
console.log('═══════════════════════════════════════');

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 1: Fcitx5 基本操作 (profile 读取 + 精确匹配)');
// ──────────────────────────────────────────────────────────────

test('createPlatformAdapter 可从 bundle 中提取', () => {
    assert.strictEqual(typeof createPlatformAdapter, 'function');
});

test('Fcitx5 检测成功（profile 存在）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('Fcitx5 profile 不存在时检测失败', () => {
    resetMock();
    mockState.profileExists = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false, 'profile 不存在应检测失败');
});

test('Fcitx5 queryMode: pinyin → zh (精确匹配)', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'pinyin';
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5 queryMode: keyboard-us → en (精确匹配)', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5 switchToEnglish 调用 fcitx5-remote -s keyboard-us', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish();
    const found = mockState.bashScripts.some(s => s.includes('fcitx5-remote') && s.includes('$1'));
    assert.ok(found, '应使用 fcitx5-remote -s "$1" 脚本');
});

test('Fcitx5 switchToChinese 调用 fcitx5-remote -s pinyin', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToChinese();
    const found = mockState.bashScripts.some(s => s.includes('fcitx5-remote') && s.includes('$1'));
    assert.ok(found, '应使用 fcitx5-remote -s "$1" 脚本');
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

test('Fcitx5 自定义 profile: rime 作为中文', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'rime';
    assert.strictEqual(adapter.queryMode(), 'zh', 'rime 应为中文');
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(adapter.queryMode(), 'en', 'keyboard-us 应为英文');
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
console.log('\n📦 测试 2: Fcitx4 基本操作 (exit code 查询)');
// ──────────────────────────────────────────────────────────────

test('Fcitx4 检测成功（Fcitx5 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('Fcitx4 queryMode: exit code 2 → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.fcitx4ExitCode = 2;
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx4 queryMode: exit code 1 → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.fcitx4ExitCode = 1;
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx4 switchToEnglish 调用 fcitx-remote -c', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish();
    const found = mockState.bashScripts.some(s => /fcitx-remote\s/.test(s));
    assert.ok(found, '应调用 fcitx-remote');
});

test('Fcitx4 switchToChinese 调用 fcitx-remote -o', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToChinese();
    const found = mockState.bashScripts.some(s => /fcitx-remote\s/.test(s));
    assert.ok(found, '应调用 fcitx-remote');
});

test('Fcitx4 queryMode: exit code 0 → en (不等于 2)', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.fcitx4ExitCode = 0;
    assert.strictEqual(adapter.queryMode(), 'en', 'exit code 0 不等于 2 应返回 en');
});

test('Fcitx4 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 1;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en', '初始英文');
    mockState.fcitx4ExitCode = 2;
    assert.strictEqual(adapter.queryMode(), 'zh', '切换后中文');
    mockState.fcitx4ExitCode = 1;
    assert.strictEqual(adapter.queryMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 3: IBus 基本操作 (精确匹配)');
// ──────────────────────────────────────────────────────────────

test('IBus 检测成功（Fcitx5/4 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('IBus queryMode: libpinyin → zh (精确匹配)', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('IBus queryMode: xkb:us::eng → en (精确匹配)', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('IBus switchToEnglish 调用 ibus engine', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish();
    const found = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(found, '应调用 ibus engine');
});

test('IBus switchToChinese 调用 ibus engine', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToChinese();
    const found = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(found, '应调用 ibus engine');
});

test('IBus queryMode: 空引擎名 → en (空结果回退)', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.ibusCurrentEngine = '';
    assert.strictEqual(adapter.queryMode(), 'en', '空引擎名应返回 en (空结果 = ibus 未运行)');
});

test('IBus 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en', '初始英文');
    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(adapter.queryMode(), 'zh', '切换后中文');
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(adapter.queryMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 4: 无 IME 可用时的回退');
// ──────────────────────────────────────────────────────────────

test('所有 IME 均不可用时 adapter.isReady() 返回 false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
});

test('不可用时 queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('不可用时 switchToEnglish 返回 success=false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.method, 'none');
});

test('不可用时连续调用安全', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    for (let i = 0; i < 100; i++) {
        adapter.switchToEnglish();
        adapter.switchToChinese();
        adapter.queryMode();
    }
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 5: 超时与异常安全');
// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────

test('fcitx5-remote 超时，queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote -n');
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('fcitx-remote 超时，Fcitx4Manager queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('echo $?');
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('ibus engine 超时，IBusManager queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('连续超时不累积阻塞：10 次调用均 < 1s', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    const adapter = createAdapter();
    const start = Date.now();
    for (let i = 0; i < 10; i++) adapter.queryMode();
    assert.ok(Date.now() - start < 1000, '10 次调用应 < 1s');
});

test('fcitx5-remote 超时，switchToEnglish 不抛异常', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote');
    const adapter = createAdapter();
    assert.doesNotThrow(() => adapter.switchToEnglish(), '超时不应阻塞');
});

test('ibus engine 超时，switchToChinese 不抛异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    const adapter = createAdapter();
    assert.doesNotThrow(() => adapter.switchToChinese(), '超时不应阻塞');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 6: 责任链降级');
// ──────────────────────────────────────────────────────────────

test('Fcitx5 不可用 → 降级到 Fcitx4', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true, '应降级到 Fcitx4');
    mockState.fcitx4ExitCode = 2;
    assert.strictEqual(adapter.queryMode(), 'zh');
    mockState.fcitx4ExitCode = 1;
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5+Fcitx4 不可用 → 降级到 IBus', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
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
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
});

test('降级后切换命令使用正确的目标', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToChinese();
    const hasFcitx4 = mockState.bashScripts.some(s => /fcitx-remote\s/.test(s));
    assert.ok(hasFcitx4, '应使用 fcitx-remote');
});

test('降级到 IBus 后切换命令正确', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish();
    const hasIbus = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(hasIbus, '应使用 ibus engine');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 7: Profile 文件边界情况');
// ──────────────────────────────────────────────────────────────

test('profile 为空文件时使用默认值', () => {
    resetMock();
    mockState.profileContent = '';
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('profile 仅有 keyboard 布局时英文使用第一个 keyboard', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-de', 'Layout=',
        '[Groups/0/Items/1]', 'Name=keyboard-fr', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'keyboard-de';
    assert.strictEqual(adapter.queryMode(), 'en', 'keyboard-de 应为英文');
});

test('profile 无中文输入法时使用默认 pinyin', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'pinyin';
    assert.strictEqual(adapter.queryMode(), 'zh', 'pinyin (默认) 应为中文');
});

test('profile 包含注释行和空行时正确解析', () => {
    resetMock();
    mockState.profileContent = [
        '# This is a comment',
        '[Groups/0]', 'Name=Default', '',
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '# Another comment', '',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.fcitx5CurrentInput = 'rime';
    assert.strictEqual(adapter.queryMode(), 'zh', 'rime 应为中文');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 8: 异常传播安全');
// ──────────────────────────────────────────────────────────────

test('readFcitx5Profile 读取异常不传播', () => {
    resetMock();
    const origRead = fs.readFileSync;
    fs.readFileSync = function(p, enc) {
        if (typeof p === 'string' && p.includes('fcitx5')) {
            throw new Error('Permission denied');
        }
        return origRead(p, enc);
    };
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    assert.doesNotThrow(() => {
        const adapter = createAdapter();
        mockState.fcitx5CurrentInput = 'keyboard-us';
        assert.strictEqual(adapter.queryMode(), 'en', '应使用默认值');
    });
    fs.readFileSync = origRead;
});

test('readFcitx5Profile 文件内容格式异常不传播', () => {
    resetMock();
    mockState.profileContent = '这不是一个有效的 profile 文件内容!!!';
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    assert.doesNotThrow(() => {
        const adapter = createAdapter();
        mockState.fcitx5CurrentInput = 'keyboard-us';
        assert.strictEqual(adapter.queryMode(), 'en');
    });
});

test('所有 bash 命令失败时 createPlatformAdapter 不传播异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    assert.doesNotThrow(() => createAdapter());
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 9: bash 命令与参数');
// ──────────────────────────────────────────────────────────────

test('fcitx5 切换脚本使用 $1 参数传递', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToChinese();
    const found = mockState.bashScripts.some(s => s.includes('$1') && s.includes('fcitx5-remote'));
    assert.ok(found, '应使用 $1 参数引用传递输入法名');
});

test('使用 execFileSync 调用 bash', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    createAdapter();
    const execFileCalls = mockState.callLog.filter(c => c.name === 'execFileSync');
    assert.ok(execFileCalls.length > 0, '应有 execFileSync 调用');
});

test('switchToEnglish 后立即 switchToChinese 不冲突', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish();
    adapter.switchToChinese();
    const switchCalls = mockState.bashScripts.filter(s => /fcitx5-remote/.test(s));
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

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 9: Bundle 内容验证');
// ──────────────────────────────────────────────────────────────

test('bundle 包含 LinuxAdapter', () => {
    assert.ok(bundleSrc.includes('LinuxAdapter'));
});

test('bundle 包含 readFcitx5Profile 函数', () => {
    assert.ok(bundleSrc.includes('readFcitx5Profile') || bundleSrc.includes('.config/fcitx5/profile'));
});

test('bundle 包含 profile 路径检测', () => {
    assert.ok(bundleSrc.includes('.config/fcitx5/profile'), '应包含 profile 路径');
});

test('bundle 包含 fcitx5-remote 调用', () => {
    assert.ok(bundleSrc.includes('fcitx5-remote'));
});

test('bundle 包含 fcitx-remote 调用', () => {
    assert.ok(bundleSrc.includes('fcitx-remote'));
});

test('bundle 包含 ibus engine 调用', () => {
    assert.ok(bundleSrc.includes('ibus engine'));
});

test('bundle 包含 command -v 检测', () => {
    assert.ok(bundleSrc.includes('command -v'), '应使用 command -v 检测');
});

test('bundle 包含 buildEnvPath (PATH 修复)', () => {
    assert.ok(bundleSrc.includes('buildEnvPath') || bundleSrc.includes('/usr/local/bin'));
});

test('bundle 包含 createPlatformAdapter', () => {
    assert.ok(bundleSrc.includes('createPlatformAdapter'));
});

test('bundle 包含平台守卫', () => {
    assert.ok(
        bundleSrc.includes('process.platform === "win32"') ||
        bundleSrc.includes("process.platform === 'win32'")
    );
});

test('bundle 包含控制器', () => {
    assert.ok(bundleSrc.includes('IMEController') || bundleSrc.includes('Controller'));
});

test('bundle 包含状态追踪器', () => {
    assert.ok(bundleSrc.includes('IMEStateTracker') || bundleSrc.includes('StateTracker'));
});

test('bundle 包含手动覆盖逻辑', () => {
    assert.ok(bundleSrc.includes('manualOverride'), '应包含 manualOverride');
});

test('bundle 包含 markAutoSwitch / markManualSwitch', () => {
    assert.ok(bundleSrc.includes('markAutoSwitch'), '应包含 markAutoSwitch');
    assert.ok(bundleSrc.includes('markManualSwitch'), '应包含 markManualSwitch');
    assert.ok(bundleSrc.includes('resetManualOverride'), '应包含 resetManualOverride');
});

test('bundle 包含光标位置跟踪', () => {
    assert.ok(bundleSrc.includes('isDifferentPosition'), '应包含 isDifferentPosition');
    assert.ok(bundleSrc.includes('lastPositionLine'), '应包含 lastPositionLine');
});

test('bundle 包含 suppress 窗口逻辑', () => {
    assert.ok(bundleSrc.includes('autoSwitchSuppressUntil'), '应包含 suppress 窗口');
});

test('bundle 包含轮询状态检测', () => {
    assert.ok(bundleSrc.includes('pollingTimer') || bundleSrc.includes('setInterval'), '应包含轮询逻辑');
});

test('bundle 包含 Fcitx5 轮询间隔', () => {
    assert.ok(bundleSrc.includes('pollingInterval'), '应包含轮询间隔配置');
});

// ──────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
console.log('═══════════════════════════════════════');

if (typeof ext.deactivate === 'function') {
    try { ext.deactivate(); } catch {}
}

process.exit(failCount > 0 ? 1 : 0);

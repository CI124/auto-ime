/**
 * Mock Linux IME 测试 - 模拟 Fcitx5 / Fcitx4 / IBus 环境
 *
 * 适配 v0.6.1 内部状态追踪架构：
 * - queryMode() 使用内部状态（不调用 execSync）
 * - switchToXxx() 目标相同时返回 skip
 * - syncState() 从系统刷新内部状态
 * - 初始状态通过构造函数中的 queryFromSystem() 获取
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
    fcitx4ExitCode: 2,
    ibusCurrentEngine: 'libpinyin',

    profileExists: true,
    profileContent: [
        '[Groups/0]', 'Name=Default', 'Default Layout=us', 'DefaultIM=pinyin', '',
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=pinyin', 'Layout=',
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
        '[Groups/0]', 'Name=Default', 'Default Layout=us', 'DefaultIM=pinyin', '',
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=pinyin', 'Layout=',
    ].join('\n');
    mockState.timeoutCommands = new Set();
    mockState.callLog = [];
    mockState.bashScripts = [];
}

// ============================================================
// 命令路由
// ============================================================
function handleBashScript(script) {
    mockState.bashScripts.push(script);

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
    if (/fcitx5-remote\s+-n/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return mockState.fcitx5CurrentInput;
    }
    if (/fcitx5-remote\s+-s/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return '';
    }
    if (/fcitx-remote/.test(script) && /echo\s+\$\?/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return String(mockState.fcitx4ExitCode);
    }
    if (/fcitx-remote\s/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }
    if (/^ibus\s+engine\s*$/.test(script.trim())) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return mockState.ibusCurrentEngine;
    }
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
// Mock fs
// ============================================================
const origExistsSync = fs.existsSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);

fs.existsSync = function(p) {
    if (typeof p === 'string' && p.includes('fcitx5') && p.includes('profile')) return mockState.profileExists;
    return origExistsSync(p);
};

fs.readFileSync = function(p, encoding) {
    if (typeof p === 'string' && p.includes('fcitx5') && p.includes('profile')) return mockState.profileContent;
    return origReadFileSync(p, encoding);
};

// ============================================================
// 拦截 require
// ============================================================
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};

const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
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
                createStatusBarItem: () => ({ text: '', tooltip: '', backgroundColor: undefined, show: () => {}, dispose: () => {}, command: '' }),
                onDidChangeWindowState: () => ({ dispose: () => {} }),
                onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
                onDidChangeTextEditorOptions: () => ({ dispose: () => {} }),
                onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
            },
            StatusBarAlignment: { Left: 1, Right: 2 },
            TextEditorCursorStyle: { Block: 4, Line: 1 },
            ThemeColor: class { constructor(s) { this.id = s; } },
            Disposable: { from: () => ({ dispose: () => {} }) },
            commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: () => Promise.resolve() },
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

const origCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
    if (filename && filename.endsWith('extension.js') && content.includes('function createPlatformAdapter(')) {
        const exportMarker = 'module.exports = __toCommonJS(extension_exports);';
        const idx = content.indexOf(exportMarker);
        if (idx !== -1) {
            content = content.slice(0, idx + exportMarker.length) + '\nmodule.exports.createPlatformAdapter = createPlatformAdapter;\n' + content.slice(idx + exportMarker.length);
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
console.log('  Mock Linux IME 测试 (v0.6.1 内部状态追踪)');
console.log('═══════════════════════════════════════');

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 1: Fcitx5 基本操作');
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
    assert.strictEqual(adapter.isReady(), false);
});

test('Fcitx5 queryMode 使用内部状态（初始 pinyin → zh）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5 queryMode 使用内部状态（初始 keyboard-us → en）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5 switchToEnglish 返回 skip（已是英文）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.method, 'skip', '已是英文应返回 skip');
});

test('Fcitx5 switchToChinese 返回 skip（已是中文）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    const result = adapter.switchToChinese();
    assert.strictEqual(result.method, 'skip', '已是中文应返回 skip');
});

test('Fcitx5 switchToEnglish 实际切换（从中文到英文）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    mockState.bashScripts = [];
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.method, 'fcitx5');
    assert.strictEqual(adapter.queryMode(), 'en', '切换后应为英文');
    const found = mockState.bashScripts.some(s => s.includes('fcitx5-remote') && s.includes('$1'));
    assert.ok(found, '应调用 fcitx5-remote -s');
});

test('Fcitx5 switchToChinese 实际切换（从英文到中文）', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    mockState.bashScripts = [];
    const result = adapter.switchToChinese();
    assert.strictEqual(result.method, 'fcitx5');
    assert.strictEqual(adapter.queryMode(), 'zh', '切换后应为中文');
});

test('Fcitx5 syncState 从系统刷新状态', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
    // 模拟外部切换（用户按了系统快捷键）
    mockState.fcitx5CurrentInput = 'pinyin';
    // syncState 应该刷新内部状态
    adapter.syncState();
    assert.strictEqual(adapter.queryMode(), 'zh', 'syncState 后应检测到中文');
});

test('Fcitx5 自定义 profile: rime', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'rime';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh', 'rime 应为中文');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 2: Fcitx4 基本操作');
// ──────────────────────────────────────────────────────────────

test('Fcitx4 检测成功（Fcitx5 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    mockState.fcitx4ExitCode = 2;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('Fcitx4 queryMode: 初始 exit code 2 → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 2;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx4 queryMode: 初始 exit code 1 → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 1;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx4 switchToEnglish 返回 skip（已是英文）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 1;
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.method, 'skip');
});

test('Fcitx4 switchToChinese 实际切换', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 1;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    const result = adapter.switchToChinese();
    assert.strictEqual(result.method, 'fcitx4');
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx4 syncState 从系统刷新', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 1;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
    mockState.fcitx4ExitCode = 2;
    adapter.syncState();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 3: IBus 基本操作');
// ──────────────────────────────────────────────────────────────

test('IBus 检测成功（Fcitx5/4 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('IBus queryMode: 初始 libpinyin → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'libpinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('IBus queryMode: 初始 xkb:us::eng → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('IBus switchToEnglish 返回 skip（已是英文）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.method, 'skip');
});

test('IBus switchToChinese 实际切换', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    mockState.bashScripts = [];
    const result = adapter.switchToChinese();
    assert.strictEqual(result.method, 'ibus');
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('IBus syncState 从系统刷新', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
    mockState.ibusCurrentEngine = 'libpinyin';
    adapter.syncState();
    assert.strictEqual(adapter.queryMode(), 'zh');
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

test('fcitx5-remote 超时，构造函数不抛异常', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote -n');
    assert.doesNotThrow(() => createAdapter());
});

test('fcitx-remote 超时，构造函数不抛异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('echo $?');
    assert.doesNotThrow(() => createAdapter());
});

test('ibus engine 超时，构造函数不抛异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    assert.doesNotThrow(() => createAdapter());
});

test('switchToEnglish 超时不抛异常', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote');
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    assert.doesNotThrow(() => adapter.switchToEnglish());
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 6: 责任链降级');
// ──────────────────────────────────────────────────────────────

test('Fcitx5 不可用 → 降级到 Fcitx4', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    mockState.fcitx4ExitCode = 2;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5+Fcitx4 不可用 → 降级到 IBus', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'libpinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
    assert.strictEqual(adapter.queryMode(), 'zh');
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

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 7: Profile 文件边界情况');
// ──────────────────────────────────────────────────────────────

test('profile 为空文件时使用默认值', () => {
    resetMock();
    mockState.profileContent = '';
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
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
    mockState.fcitx5CurrentInput = 'keyboard-de';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('profile 包含注释行和空行时正确解析', () => {
    resetMock();
    mockState.profileContent = [
        '# comment', '[Groups/0]', 'Name=Default', '',
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '# another', '', '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'rime';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 8: 异常传播安全');
// ──────────────────────────────────────────────────────────────

test('readFcitx5Profile 读取异常不传播', () => {
    resetMock();
    const origRead = fs.readFileSync;
    fs.readFileSync = function(p, enc) {
        if (typeof p === 'string' && p.includes('fcitx5')) throw new Error('Permission denied');
        return origRead(p, enc);
    };
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    assert.doesNotThrow(() => createAdapter());
    fs.readFileSync = origRead;
});

test('所有命令失败时 createPlatformAdapter 不传播异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    assert.doesNotThrow(() => createAdapter());
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 9: 接口验证');
// ──────────────────────────────────────────────────────────────

test('返回对象实现 IPlatformAdapter 接口', () => {
    resetMock();
    const adapter = createAdapter();
    assert.strictEqual(typeof adapter.name, 'string');
    assert.strictEqual(typeof adapter.isReady, 'function');
    assert.strictEqual(typeof adapter.queryMode, 'function');
    assert.strictEqual(typeof adapter.switchToEnglish, 'function');
    assert.strictEqual(typeof adapter.switchToChinese, 'function');
    assert.strictEqual(typeof adapter.syncState, 'function');
});

test('switchToEnglish 后立即 switchToChinese 不冲突', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish(); // skip
    adapter.switchToChinese(); // actual switch
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('多次 createPlatformAdapter 返回独立实例', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter1 = createAdapter();
    assert.strictEqual(adapter1.queryMode(), 'en');
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter2 = createAdapter();
    assert.strictEqual(adapter2.queryMode(), 'zh');
    assert.strictEqual(adapter1.queryMode(), 'en', 'adapter1 状态不受 adapter2 影响');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 10: Bundle 内容验证');
// ──────────────────────────────────────────────────────────────

test('bundle 包含 LinuxAdapter', () => assert.ok(bundleSrc.includes('LinuxAdapter')));
test('bundle 包含 readFcitx5Profile', () => assert.ok(bundleSrc.includes('readFcitx5Profile') || bundleSrc.includes('.config/fcitx5/profile')));
test('bundle 包含 fcitx5-remote 调用', () => assert.ok(bundleSrc.includes('fcitx5-remote')));
test('bundle 包含 fcitx-remote 调用', () => assert.ok(bundleSrc.includes('fcitx-remote')));
test('bundle 包含 ibus engine 调用', () => assert.ok(bundleSrc.includes('ibus engine')));
test('bundle 包含 command -v 检测', () => assert.ok(bundleSrc.includes('command -v')));
test('bundle 包含 buildEnvPath', () => assert.ok(bundleSrc.includes('buildEnvPath') || bundleSrc.includes('/usr/local/bin')));
test('bundle 包含 createPlatformAdapter', () => assert.ok(bundleSrc.includes('createPlatformAdapter')));
test('bundle 包含平台守卫', () => assert.ok(bundleSrc.includes('process.platform === "win32"') || bundleSrc.includes("process.platform === 'win32'")));
test('bundle 包含控制器', () => assert.ok(bundleSrc.includes('IMEController') || bundleSrc.includes('Controller')));
test('bundle 包含状态追踪器', () => assert.ok(bundleSrc.includes('IMEStateTracker') || bundleSrc.includes('StateTracker')));
test('bundle 包含手动覆盖逻辑', () => assert.ok(bundleSrc.includes('manualOverride')));
test('bundle 包含 markAutoSwitch / markManualSwitch', () => assert.ok(bundleSrc.includes('markAutoSwitch') && bundleSrc.includes('markManualSwitch') && bundleSrc.includes('resetManualOverride')));
test('bundle 包含 notifyAutoSwitch', () => assert.ok(bundleSrc.includes('notifyAutoSwitch')));
test('bundle 包含 syncState', () => assert.ok(bundleSrc.includes('syncState')));
test('bundle 包含 suppress 窗口逻辑', () => assert.ok(bundleSrc.includes('autoSwitchSuppressUntil')));
test('bundle 包含轮询状态检测', () => assert.ok(bundleSrc.includes('pollingTimer') || bundleSrc.includes('setInterval')));

// ──────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
console.log('═══════════════════════════════════════');

if (typeof ext.deactivate === 'function') { try { ext.deactivate(); } catch {} }
process.exit(failCount > 0 ? 1 : 0);

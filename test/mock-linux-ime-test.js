/**
 * Mock Linux IME 测试 - 模拟 Fcitx5 / IBus 环境
 *
 * v0.7.0 架构：
 * - Fcitx5 + IBus（Fcitx4 已移除）
 * - D-Bus 信号监听（事件驱动，不轮询）
 * - 内部状态追踪 + syncState
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
    ibusAvailable: true,

    fcitx5CurrentInput: 'pinyin',
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
    mockState.ibusAvailable = true;
    mockState.fcitx5CurrentInput = 'pinyin';
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
console.log('  Mock Linux IME 测试 (v0.7.0 D-Bus 事件驱动)');
console.log('═══════════════════════════════════════');

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 1: Fcitx5 基本操作');
// ──────────────────────────────────────────────────────────────

test('createPlatformAdapter 可从 bundle 中提取', () => {
    assert.strictEqual(typeof createPlatformAdapter, 'function');
});

test('Fcitx5 检测成功（profile 存在）', () => {
    resetMock();
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('Fcitx5 profile 不存在时检测失败', () => {
    resetMock();
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
});

test('Fcitx5 queryMode 使用内部状态（初始 pinyin → zh）', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5 queryMode 使用内部状态（初始 keyboard-us → en）', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5 switchToEnglish 返回 skip（已是英文）', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    assert.strictEqual(adapter.switchToEnglish().method, 'skip');
});

test('Fcitx5 switchToChinese 返回 skip（已是中文）', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.switchToChinese().method, 'skip');
});

test('Fcitx5 switchToEnglish 实际切换', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    mockState.bashScripts = [];
    const result = adapter.switchToEnglish();
    assert.strictEqual(result.method, 'fcitx5');
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('Fcitx5 switchToChinese 实际切换', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    mockState.bashScripts = [];
    const result = adapter.switchToChinese();
    assert.strictEqual(result.method, 'fcitx5');
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5 syncState 从系统刷新', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
    mockState.fcitx5CurrentInput = 'pinyin';
    adapter.syncState();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('Fcitx5 自定义 profile: rime', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'rime';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 2: IBus 基本操作');
// ──────────────────────────────────────────────────────────────

test('IBus 检测成功（Fcitx5 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
});

test('IBus queryMode: 初始 libpinyin → zh', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'libpinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('IBus queryMode: 初始 xkb:us::eng → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('IBus switchToEnglish 返回 skip（已是英文）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.switchToEnglish().method, 'skip');
});

test('IBus switchToChinese 实际切换', () => {
    resetMock();
    mockState.fcitx5Available = false;
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
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
    mockState.ibusCurrentEngine = 'libpinyin';
    adapter.syncState();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 3: 无 IME 可用时的回退');
// ──────────────────────────────────────────────────────────────

test('所有 IME 均不可用时 adapter.isReady() 返回 false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
});

test('不可用时 queryMode 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'en');
});

test('不可用时 switchToEnglish 返回 success=false', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.switchToEnglish().success, false);
    assert.strictEqual(adapter.switchToEnglish().method, 'none');
});

test('不可用时连续调用安全', () => {
    resetMock();
    mockState.fcitx5Available = false;
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
console.log('\n📦 测试 4: 超时与异常安全');
// ──────────────────────────────────────────────────────────────

test('fcitx5-remote 超时，构造函数不抛异常', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote -n');
    assert.doesNotThrow(() => createAdapter());
});

test('ibus engine 超时，构造函数不抛异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    assert.doesNotThrow(() => createAdapter());
});

test('switchToEnglish 超时不抛异常', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote');
    mockState.fcitx5CurrentInput = 'pinyin';
    const adapter = createAdapter();
    assert.doesNotThrow(() => adapter.switchToEnglish());
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 5: 责任链降级');
// ──────────────────────────────────────────────────────────────

test('Fcitx5 不可用 → 降级到 IBus', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'libpinyin';
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), true);
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('全部不可用 → adapter 不可用', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    assert.strictEqual(adapter.isReady(), false);
});

test('降级到 IBus 后切换命令正确', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    const adapter = createAdapter();
    mockState.bashScripts = [];
    adapter.switchToEnglish();
    const hasIbus = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(hasIbus, '应使用 ibus engine');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 6: Profile 文件边界情况');
// ──────────────────────────────────────────────────────────────

test('profile 为空文件时使用默认值', () => {
    resetMock();
    mockState.profileContent = '';
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
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'rime';
    const adapter = createAdapter();
    assert.strictEqual(adapter.queryMode(), 'zh');
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 7: 异常传播安全');
// ──────────────────────────────────────────────────────────────

test('readFcitx5Profile 读取异常不传播', () => {
    resetMock();
    const origRead = fs.readFileSync;
    fs.readFileSync = function(p, enc) {
        if (typeof p === 'string' && p.includes('fcitx5')) throw new Error('Permission denied');
        return origRead(p, enc);
    };
    mockState.ibusAvailable = false;
    assert.doesNotThrow(() => createAdapter());
    fs.readFileSync = origRead;
});

test('所有命令失败时 createPlatformAdapter 不传播异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    assert.doesNotThrow(() => createAdapter());
});

// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 8: 接口验证');
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
    assert.strictEqual(typeof adapter.startListening, 'function');
    assert.strictEqual(typeof adapter.dispose, 'function');
});

test('switchToEnglish 后立即 switchToChinese 不冲突', () => {
    resetMock();
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const adapter = createAdapter();
    adapter.switchToEnglish(); // skip
    adapter.switchToChinese(); // actual switch
    assert.strictEqual(adapter.queryMode(), 'zh');
});

test('多次 createPlatformAdapter 返回独立实例', () => {
    resetMock();
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
console.log('\n📦 测试 9: Bundle 内容验证');
// ──────────────────────────────────────────────────────────────

test('bundle 包含 LinuxAdapter', () => assert.ok(bundleSrc.includes('LinuxAdapter')));
test('bundle 包含 Fcitx5Manager', () => assert.ok(bundleSrc.includes('Fcitx5Manager')));
test('bundle 包含 IBusManager', () => assert.ok(bundleSrc.includes('IBusManager')));
test('bundle 不包含 Fcitx4Manager', () => assert.ok(!bundleSrc.includes('Fcitx4Manager')));
test('bundle 不包含 fcitx-remote', () => assert.ok(!bundleSrc.includes('fcitx-remote')));
test('bundle 包含 readFcitx5Profile', () => assert.ok(bundleSrc.includes('readFcitx5Profile') || bundleSrc.includes('.config/fcitx5/profile')));
test('bundle 包含 fcitx5-remote 调用', () => assert.ok(bundleSrc.includes('fcitx5-remote')));
test('bundle 包含 ibus engine 调用', () => assert.ok(bundleSrc.includes('ibus engine')));
test('bundle 包含 command -v 检测', () => assert.ok(bundleSrc.includes('command -v')));
test('bundle 包含 DbusIMEListener', () => assert.ok(bundleSrc.includes('DbusIMEListener')));
test('bundle 包含 FCITX5_DBUS 配置', () => assert.ok(bundleSrc.includes('org.fcitx.Fcitx5')));
test('bundle 包含 IBUS_DBUS 配置', () => assert.ok(bundleSrc.includes('org.freedesktop.IBus')));
test('bundle 包含 InputMethodChanged 信号', () => assert.ok(bundleSrc.includes('InputMethodChanged')));
test('bundle 包含 GlobalEngineChanged 信号', () => assert.ok(bundleSrc.includes('GlobalEngineChanged')));
test('bundle 包含 startListening 方法', () => assert.ok(bundleSrc.includes('startListening')));
test('bundle 包含 handleExternalSwitch', () => assert.ok(bundleSrc.includes('handleExternalSwitch')));
test('bundle 包含 createPlatformAdapter', () => assert.ok(bundleSrc.includes('createPlatformAdapter')));
test('bundle 包含平台守卫', () => assert.ok(bundleSrc.includes('process.platform === "win32"') || bundleSrc.includes("process.platform === 'win32'")));
test('bundle 包含 notifyAutoSwitch', () => assert.ok(bundleSrc.includes('notifyAutoSwitch')));
test('bundle 包含 syncState', () => assert.ok(bundleSrc.includes('syncState')));
test('bundle 包含 manualOverride', () => assert.ok(bundleSrc.includes('manualOverride')));

// ──────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
console.log('═══════════════════════════════════════');

if (typeof ext.deactivate === 'function') { try { ext.deactivate(); } catch {} }
process.exit(failCount > 0 ? 1 : 0);

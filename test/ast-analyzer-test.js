/**
 * ASTAnalyzer 单元测试 —— 针对【真实源码】
 *
 * 与旧版关键区别：旧文件在测试内部“复现”了一份 ASTAnalyzer 逻辑（且已与源码漂移：
 * CSS 误用 // 行注释、把 string 当 comment 等），根本不加载真实类，属于假绿灯。
 *
 * 本版本用 esbuild 现场把真实的 src/ASTAnalyzer.ts 打成内存模块并加载，
 * 直接调用真实对象的 isCursorInCommentFast / isCursorInCommentOrString，
 * 因此修改 ASTAnalyzer.ts 会真实反映到测试结果上。
 *
 * 真实语义（与 LANGUAGE_PROFILES.query 对齐）：
 *   - 注释节点       → { match: true, type: 'comment' }
 *   - 字符串/模板串  → { match: true, type: 'string' }   （不是 'comment'！）
 *   - 代码           → { match: false, type: null }
 *
 * 运行：node test/ast-analyzer-test.js（需先 npm run compile，dist/ 下 wasm 就绪）
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const esbuild = require('esbuild');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

// ============================================================
// 测试框架（串行、真正 await 异步用例）
// ============================================================
let testCount = 0, passCount = 0, failCount = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function section(title) { queue.push({ section: title }); }

// ============================================================
// Mock vscode（真实 ASTAnalyzer 只在类型位置引用 vscode，运行期一般不 require；
// 这里仍安装兜底 mock，避免 esbuild 万一保留 require('vscode') 时崩溃）
// ============================================================
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, parent, isMain, options);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return {};
    return origLoad.call(this, request, parent, isMain);
};

// ============================================================
// 加载真实 ASTAnalyzer 类（内存打包，不落盘）
// ============================================================
function loadAnalyzerClass() {
    const result = esbuild.buildSync({
        stdin: {
            contents: `export { ASTAnalyzer } from './src/analysis/ASTAnalyzer';`,
            resolveDir: REPO_ROOT,
            loader: 'ts',
            sourcefile: 'ast-real-entry.ts',
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
    // __dirname 传给 dist，使 tree-sitter 核心 wasm 与语言 wasm 均被正确定位
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    fn(mod.exports, require, mod, path.join(DIST_DIR, 'ast-real-entry.js'), DIST_DIR);
    return mod.exports.ASTAnalyzer;
}

function makeLogger() {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => console.error('   [analyzer error]', m) };
}

let mockDocSeq = 0;
function createMockDocument(text, languageId) {
    const lines = text.split('\n');
    const id = ++mockDocSeq;
    return {
        languageId,
        // 提供唯一 uri/version，让 ASTAnalyzer 的 (uri,version) 文本缓存正确区分文档
        uri: { toString: () => `file:///mock/doc-${id}` },
        version: 0,
        getText: () => text,
        lineAt: (line) => ({ text: lines[line] }),
        offsetAt: (position) => {
            let offset = 0;
            for (let i = 0; i < position.line; i++) offset += lines[i].length + 1;
            return offset + position.character;
        },
    };
}
function pos(line, character) { return { line, character }; }

// ============================================================
// 主流程
// ============================================================
async function main() {
    console.log('═══════════════════════════════════════');
    console.log('  ASTAnalyzer 单元测试（真实源码）');
    console.log('═══════════════════════════════════════');

    assert.ok(fs.existsSync(path.join(DIST_DIR, 'tree-sitter.wasm')),
        '缺少 dist/tree-sitter.wasm，请先运行 npm run compile');
    assert.ok(fs.existsSync(path.join(DIST_DIR, 'wasm')),
        '缺少 dist/wasm/，请先运行 npm run compile');

    const ASTAnalyzer = loadAnalyzerClass();
    const context = { extensionPath: REPO_ROOT, subscriptions: [], globalStorageUri: { fsPath: REPO_ROOT } };
    const makeAnalyzer = () => new ASTAnalyzer(context, { appendLine: () => {} }, makeLogger());

    // 共享实例：仅用于不需要解析的快速路径与 init/dispose 生命周期测试
    const shared = makeAnalyzer();
    await shared.init();

    // 每个 AST 语义用例用【独立实例 + 全文解析】，避免跨文档复用 lastTree 造成的
    // 增量解析污染（真实运行只在当前活动文档上增量解析）。
    async function astAnalyze(doc, position) {
        const an = makeAnalyzer();
        await an.init();
        try {
            return await an.isCursorInCommentOrString(doc, position);
        } finally {
            an.dispose();
        }
    }
    const fastAnalyze = (doc, position, lang) => shared.isCursorInCommentFast(doc, position, lang);

    // ---- 2: TypeScript 真实分类 ----
    section('📦 2: TypeScript 真实分类（comment vs string）');
    const TS = [
        '// 计算两个数的和',                 // 0
        'function add(a: number, b: number): number {', // 1
        '    const result = a + b; // 存储结果', // 2
        '    return result;',                // 3
        '}',                                 // 4
        '/* 多行注释',                        // 5
        '   描述函数功能 */',                 // 6
        'const greeting = "你好世界";',       // 7
        'const template = `tpl-${name}`;',    // 8
    ].join('\n');
    const tsDoc = createMockDocument(TS, 'typescript');

    test('AST: 行注释 → comment', async () => {
        const r = await astAnalyze(tsDoc, pos(0, 4));
        assert.strictEqual(r.match, true);
        assert.strictEqual(r.type, 'comment');
    });
    test('AST: 行尾注释 → comment', async () => {
        const r = await astAnalyze(tsDoc, pos(2, 30));
        assert.strictEqual(r.match, true);
        assert.strictEqual(r.type, 'comment');
    });
    test('AST: 多行注释第 2 行 → comment', async () => {
        const r = await astAnalyze(tsDoc, pos(6, 5));
        assert.strictEqual(r.match, true);
        assert.strictEqual(r.type, 'comment');
    });
    test('AST: 字符串 → type=string（真实语义，非 comment）', async () => {
        const r = await astAnalyze(tsDoc, pos(7, 19));
        assert.strictEqual(r.match, true);
        assert.strictEqual(r.type, 'string');
    });
    test('AST: 模板字符串 → type=string', async () => {
        const r = await astAnalyze(tsDoc, pos(8, 18));
        assert.strictEqual(r.match, true);
        assert.strictEqual(r.type, 'string');
    });
    test('AST: 普通代码 → 不匹配', async () => {
        const r = await astAnalyze(tsDoc, pos(1, 4));
        assert.strictEqual(r.match, false);
    });

    // ---- 3: 快速文本路径 ----
    section('📦 3: 快速文本路径 isCursorInCommentFast');
    test('Fast: TS 行注释 → true', () => {
        const d = createMockDocument('const x = 42; // 注释', 'typescript');
        assert.strictEqual(fastAnalyze(d, pos(0, 18), 'typescript'), true);
    });
    test('Fast: TS 字符串内 // → null（需 AST）', () => {
        const d = createMockDocument('const s = "// not";', 'typescript');
        assert.strictEqual(fastAnalyze(d, pos(0, 14), 'typescript'), null);
    });
    test('Fast: 块注释内部 → true', () => {
        const text = 'const x = 42; /* block\n   comment */ const y = 1;';
        const d = createMockDocument(text, 'typescript');
        assert.strictEqual(fastAnalyze(d, pos(1, 5), 'typescript'), true);
    });
    test('Fast: 光标前仅空白 → false', () => {
        const d = createMockDocument('    const x = 42;', 'typescript');
        assert.strictEqual(fastAnalyze(d, pos(0, 2), 'typescript'), false);
    });
    // 回归守卫：CSS 没有 // 行注释，url("http://..") 不得被误判为注释
    test('Fast: CSS 中的 // 不判为注释（回归 CSS 修复）', () => {
        const d = createMockDocument('a { background: url("http://x"); }', 'css');
        const r = fastAnalyze(d, pos(0, 25), 'css');
        assert.notStrictEqual(r, true, 'CSS // 不应触发注释快路径');
    });

    // ---- 4: Python / C++ 语义 ----
    section('📦 4: Python / C++ 语义');
    const PY = [
        '# 顶部注释',                       // 0
        'def add(a, b):',                    // 1
        '    """文档字符串"""',              // 2
        '    return a + b  # 行尾',          // 3
    ].join('\n');
    const pyDoc = createMockDocument(PY, 'python');
    test('AST(PY): # 注释 → comment', async () => {
        const r = await astAnalyze(pyDoc, pos(0, 3));
        assert.strictEqual(r.type, 'comment');
    });
    test('AST(PY): 三引号 docstring → string（Python 无块注释）', async () => {
        const r = await astAnalyze(pyDoc, pos(2, 8));
        assert.strictEqual(r.match, true);
        assert.strictEqual(r.type, 'string');
    });
    const CPP = [
        'int add(int a, int b) { return a + b; } // 注释', // 0
        'const char* s = "你好";',                          // 1
        'auto r = R"(原始串)";',                            // 2
    ].join('\n');
    const cppDoc = createMockDocument(CPP, 'cpp');
    test('AST(CPP): string_literal → string', async () => {
        const r = await astAnalyze(cppDoc, pos(1, 18));
        assert.strictEqual(r.type, 'string');
    });
    test('AST(CPP): raw_string_literal → string', async () => {
        const r = await astAnalyze(cppDoc, pos(2, 12));
        assert.strictEqual(r.type, 'string');
    });

    // ---- 5: 边界 ----
    section('📦 5: 边界与特殊处理');
    test('边界: 空文档 → 不匹配', async () => {
        const d = createMockDocument('', 'typescript');
        const r = await astAnalyze(d, pos(0, 0));
        assert.strictEqual(r.match, false);
    });
    test('边界: 光标在注释起始 "/" → 不算在注释内', async () => {
        const d = createMockDocument('const x = 42; // c', 'typescript');
        const slash = 'const x = 42; '.length; // 第一个 '/' 的列
        const r = await astAnalyze(d, pos(0, slash));
        assert.strictEqual(r.match, false);
    });
    test('边界: 未知语言 → 不匹配（平滑降级）', async () => {
        const d = createMockDocument('anything', 'unknown-lang-xyz');
        const r = await astAnalyze(d, pos(0, 0));
        assert.strictEqual(r.match, false);
    });

    // ---- 6: 增量解析（同一实例、同一文档，正确复用 lastTree） ----
    section('📦 6: 增量解析（真实对象）');
    test('增量解析: 同文档连续两次解析结果稳定为 comment', async () => {
        const an = makeAnalyzer();
        await an.init();
        try {
            const lines = [];
            for (let i = 0; i < 1500; i++) {
                lines.push(i % 250 === 0
                    ? `// section ${i} xxxxxxxxxxxxxxxxxxxxxxxxxx`
                    : `const v${i} = ${i}; // value ${i} padding`);
            }
            let code = lines.join('\n');
            const r1 = await an.isCursorInCommentOrString(createMockDocument(code, 'typescript'), pos(0, 5));
            assert.strictEqual(r1.type, 'comment', '首次解析应在注释中');
            // 末尾追加内容后再解析（走增量路径复用 lastTree）
            code += '\nconst tail = "appended"; // tail comment';
            const r2 = await an.isCursorInCommentOrString(createMockDocument(code, 'typescript'), pos(0, 5));
            assert.strictEqual(r2.type, 'comment', '增量解析后仍应在注释中');
        } finally {
            an.dispose();
        }
    });

    // ---- 7: 资源释放 ----
    section('📦 7: 资源释放');
    test('dispose() 幂等（重复调用不抛异常）', () => {
        shared.dispose();
        shared.dispose();
        assert.ok(true);
    });

    // ---- 8: 正式构建产物文本断言（保留旧版有意义的名义守卫） ----
    section('📦 8: dist/extension.js 名义守卫');
    test('bundle 含 ASTAnalyzer 关键方法名', () => {
        const bundleSrc = fs.readFileSync(path.join(DIST_DIR, 'extension.js'), 'utf-8');
        assert.ok(bundleSrc.includes('ASTAnalyzer'));
        assert.ok(bundleSrc.includes('isCursorInCommentFast'));
        assert.ok(bundleSrc.includes('isCursorInCommentOrString'));
    });
    test('bundle 覆盖 13 种语言 WASM 映射', () => {
        const bundleSrc = fs.readFileSync(path.join(DIST_DIR, 'extension.js'), 'utf-8');
        const expected = [
            'tree-sitter-typescript.wasm', 'tree-sitter-javascript.wasm', 'tree-sitter-python.wasm',
            'tree-sitter-go.wasm', 'tree-sitter-rust.wasm', 'tree-sitter-c.wasm', 'tree-sitter-cpp.wasm',
            'tree-sitter-html.wasm', 'tree-sitter-css.wasm', 'tree-sitter-lua.wasm', 'tree-sitter-java.wasm',
            'tree-sitter-kotlin.wasm', 'tree-sitter-bash.wasm',
        ];
        for (const w of expected) assert.ok(bundleSrc.includes(w), `bundle 应含 ${w}`);
    });

    // ============================================================
    // 串行执行队列
    // ============================================================
    for (const item of queue) {
        if (item.section) { console.log(`\n${item.section}`); continue; }
        // 上面已就地 await 的“增量”用例没有 fn，跳过
        if (!item.fn) continue;
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

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });

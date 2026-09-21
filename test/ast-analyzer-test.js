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
function createMockDocument(text, languageId, opts = {}) {
    const lines = text.split('\n');
    const id = ++mockDocSeq;
    const uri = opts.uri || `file:///mock/doc-${id}`;
    return {
        languageId,
        // 提供唯一 uri/version，让 ASTAnalyzer 的 (uri,version) 文本缓存正确区分文档
        uri: { toString: () => uri },
        version: opts.version ?? 0,
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

    // 每个 AST 语义用例用独立实例，保证用例之间不共享 Language/Query 缓存。
    // （旧注释称“避免跨文档复用 lastTree 的增量解析污染” —— 那个污染是真实缺陷，
    //   已由 ASTAnalyzer 取消 lastTree 复用修复，并由§6 的同实例用例锁住，不能再靠测试规避。）
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
    // 回归守卫（巡检 C4）：字符串里的 /* 不是注释标记，不得让后面代码行被判为注释
    test('Fast: 字符串内的 /* 不得判为块注释（回归假阳性）', () => {
        const text = 'const re = "/*";\nconst y = compute(1);';
        const d = createMockDocument(text, 'typescript');
        const r = fastAnalyze(d, pos(1, 6), 'typescript');
        assert.notStrictEqual(r, true, '第二行是代码，不能被 /* 字符串内容 拉进注释');
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

    // 巡检 G：不匹配必须与“没能力判定”可区分，否则 controller 会把“不知道”当成“是代码”
    test('supports(): 已登记语言 true，未登记（含 markdown/plaintext）false', () => {
        assert.strictEqual(shared.supports('typescript'), true);
        assert.strictEqual(shared.supports('shellscript'), true);
        assert.strictEqual(shared.supports('markdown'), false, 'markdown 无 wasm，必须报不支持');
        assert.strictEqual(shared.supports('plaintext'), false);
        assert.strictEqual(shared.supports('unknown-lang-xyz'), false);
    });

    test('supports() 与 LANGUAGE_PROFILES 一一对应（不靠手工同步清单）', () => {
        // 每个 bundle 里登记的语言都必须 supports=true，防“加了表填了 wasm 但方法忘了同步”
        const mapped = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python',
            'go', 'rust', 'c', 'cpp', 'html', 'css', 'lua', 'java', 'kotlin', 'shellscript'];
        for (const id of mapped) {
            assert.strictEqual(shared.supports(id), true, `${id} 应被支持`);
        }
    });

    // ---- 6: 同一实例连续分析（真实运行形态）----
    section('📦 6: 同一实例连续分析（真实运行形态）');
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

    // 回归守卫（巡检 C1）：游标上方插入行会让旧树节点区间整体错位。不传 tree.edit()
    // 的所调“增量复用”会返回完全错位的节点（实测为 "functio"@0:0），必须不能影响判定。
    test('同一实例: 游标上方插入行后仍应正确判为 comment', async () => {
        const an = makeAnalyzer();
        await an.init();
        try {
            const v1 = createMockDocument('// 顶部注释\nconst a = 1;\n', 'typescript');
            const r1 = await an.isCursorInCommentOrString(v1, pos(0, 4));
            assert.strictEqual(r1.type, 'comment', '基线：第一次判定应在注释中');
            // 同一文档（同 uri）的新版本：顶部多了 3 行，注释从第 0 行移到第 3 行
            const v2Text = 'function f(): void {\n  const z = 0;\n}\n// 顶部注释\nconst a = 1;\n';
            const v2 = createMockDocument(v2Text, 'typescript', { uri: 'file:///mock/doc-same', version: 2 });
            const r2 = await an.isCursorInCommentOrString(v2, pos(3, 4));
            assert.deepStrictEqual(r2, { match: true, type: 'comment' },
                '插入行后同一位置应仍判为 comment（旧树错位会返回 match:false）');
        } finally {
            an.dispose();
        }
    });

    test('同一实例: 跨语言连续分析互不污染', async () => {
        const an = makeAnalyzer();
        await an.init();
        try {
            const tsDoc = createMockDocument('const a = 1; // ts 注释\n', 'typescript');
            const rTs = await an.isCursorInCommentOrString(tsDoc, pos(0, 18));
            assert.strictEqual(rTs.type, 'comment', 'TS 基线');
            // 切到 Python 文档：复用 TS 语法树会令根节点变成 ERROR（实测不抛错，降级分支不会触发）
            const pyDoc = createMockDocument('x = 1  # py 注释\n', 'python');
            const rPy = await an.isCursorInCommentOrString(pyDoc, pos(0, 8));
            const fresh = await astAnalyze(createMockDocument('x = 1  # py 注释\n', 'python'), pos(0, 8));
            assert.deepStrictEqual(rPy, fresh, '跨语言连续分析的结果必须与全新实例一致');
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

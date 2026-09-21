import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import * as path from 'path';
import { LogSink } from '../infra/logger';
import { IAnalyzer } from '../core/types';

/**
 * 【开发者必读】：WASM 文件存放与构建说明
 * 
 * 1. web-tree-sitter 需要对应的 language wasm 文件 (例如: tree-sitter-javascript.wasm, tree-sitter-typescript.wasm, tree-sitter-python.wasm)。
 * 2. 在实际发布时，你需要从 npm 获取对应的包 (例如 `tree-sitter-javascript`)，
 *    然后将其中的 `.wasm` 文件拷贝到扩展的输出目录 (通常是本项目的 ./wasm 文件夹)。
 * 3. 本实现动态映射 VSCode languageId 到 wasm 文件名称。
 * 4. 如果遇到找不到 wasm 的情况，语法树解析会平滑降级，返回 false，此时不会触发任何输入法切换。
 */

/**
 * Per-language configuration, single source of truth.
 * Adding a language = adding ONE entry here.
 *
 * `lineComments` / `blockComments` only feed the *fast text path*; when a marker is
 * unknown or absent we simply fall back to the AST path, which is the source of truth.
 */
interface LanguageProfile {
    /** Tree-sitter grammar wasm file name */
    wasmFile: string;
    /** Query source capturing comment / string nodes (capture names: comment | string) */
    query: string;
    /** Line-comment openers; empty when the language has none (e.g. CSS) */
    lineComments: string[];
    /** Block-comment [open, close]; null when the language has none */
    blockComments: [string, string] | null;
}

const C_STYLE_BLOCK: [string, string] = ['/*', '*/'];

// 多个语言共享同一“行注释 // + /* 块注释 */ + 注释/字符串捕获”形态，用工厂去重，
// 新增同构语言 = 调用一次工厂（保留 wasm 文件名字面量，供构建产物名义断言）。
const JS_TS_QUERY = `(comment) @comment\n(string) @string\n(template_string) @string`;
const STRING_LITERAL_QUERY = `(comment) @comment\n(string_literal) @string`;

function slashSlashLineProfile(wasmFile: string, query: string): LanguageProfile {
    return { wasmFile, query, lineComments: ['//'], blockComments: C_STYLE_BLOCK };
}

const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
    typescript: slashSlashLineProfile('tree-sitter-typescript.wasm', JS_TS_QUERY),
    typescriptreact: slashSlashLineProfile('tree-sitter-typescript.wasm', JS_TS_QUERY),
    javascript: slashSlashLineProfile('tree-sitter-javascript.wasm', JS_TS_QUERY),
    javascriptreact: slashSlashLineProfile('tree-sitter-javascript.wasm', JS_TS_QUERY),
    python: {
        wasmFile: 'tree-sitter-python.wasm',
        query: `(comment) @comment\n(string) @string`,
        lineComments: ['#'],
        blockComments: null, // 三引号字符串不是注释，交给 AST 路径
    },
    go: {
        wasmFile: 'tree-sitter-go.wasm',
        query: `(comment) @comment\n(interpreted_string_literal) @string\n(raw_string_literal) @string`,
        lineComments: ['//'],
        blockComments: C_STYLE_BLOCK,
    },
    rust: {
        wasmFile: 'tree-sitter-rust.wasm',
        query: `(line_comment) @comment\n(block_comment) @comment\n(string_literal) @string\n(raw_string_literal) @string`,
        lineComments: ['//'],
        blockComments: C_STYLE_BLOCK, // Rust 允许嵌套块注释，快路径仅作近似
    },
    c: {
        wasmFile: 'tree-sitter-c.wasm',
        query: `(comment) @comment\n(string_literal) @string`,
        lineComments: ['//'],
        blockComments: C_STYLE_BLOCK,
    },
    cpp: {
        wasmFile: 'tree-sitter-cpp.wasm',
        query: `(comment) @comment\n(string_literal) @string\n(raw_string_literal) @string`,
        lineComments: ['//'],
        blockComments: C_STYLE_BLOCK,
    },
    html: {
        wasmFile: 'tree-sitter-html.wasm',
        query: `(comment) @comment`,
        lineComments: ['<!--'],
        blockComments: null, // 单行 <!-- 已被 lineComments 覆盖，多行注释由 AST 路径处理
    },
    css: {
        wasmFile: 'tree-sitter-css.wasm',
        query: `(comment) @comment`,
        lineComments: [], // CSS 没有 // 行注释：旧配置会把 url("http://…") 误判为注释
        blockComments: C_STYLE_BLOCK,
    },
    lua: {
        wasmFile: 'tree-sitter-lua.wasm',
        query: `(comment) @comment\n(string) @string`,
        lineComments: ['--'],
        blockComments: null, // Lua 块注释是 --[[ ]]，由 AST 路径处理
    },
    java: slashSlashLineProfile('tree-sitter-java.wasm', STRING_LITERAL_QUERY),
    kotlin: slashSlashLineProfile('tree-sitter-kotlin.wasm', STRING_LITERAL_QUERY),
    shellscript: {
        wasmFile: 'tree-sitter-bash.wasm',
        query: `(comment) @comment\n(string) @string\n(raw_string) @string\n(heredoc_body) @string`,
        lineComments: ['#'],
        blockComments: null,
    },
};

export class ASTAnalyzer implements IAnalyzer {
    private parser: Parser | null = null;
    private initialized = false;
    private languageMap = new Map<string, Parser.Language | null>();
    private extensionContext: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private logger: LogSink;

    // 按 (uri, version) 缓存整篇文本：块注释快路径与 AST 路径都需要整篇 getText()，
    // 同一文件版本内游标多次移动时复用，避免每次事件重新物化整篇字符串
    private cachedDocKey = '';
    private cachedDocText = '';
    // 取消机制: 每次分析递增，过期的解析结果会被丢弃
    private analysisGeneration = 0;

    // 编译后的 Query 对象缓存
    private queryCache = new Map<string, Parser.Query | null>();

    // 已记录的未映射语言 ID（避免重复日志）
    private unmappedLanguagesLogged = new Set<string>();

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel, logger: LogSink) {
        this.extensionContext = context;
        this.outputChannel = outputChannel;
        this.logger = logger;
    }

    /**
     * 初始化 web-tree-sitter。扩展激活时调用一次即可。
     */
    public async init() {
        if (this.initialized) return;
        try {
            await Parser.init({
                locateFile(scriptName: string, scriptDirectory: string) {
                    // 让 web-tree-sitter 知道如何加载它的核心 tree-sitter.wasm
                    // 由于 esbuild.js 拷贝了该文件到 out/ 目录下，使用 __dirname 可准确定位
                    return path.join(__dirname, scriptName);
                }
            });
            this.parser = new Parser();
            this.initialized = true;
            this.logger.info('Tree-sitter initialized successfully.');
        } catch (error) {
            this.logger.error(`Failed to initialize Tree-sitter: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 按需加载特定的语言 WASM 模块
     * @param languageId vscode的语言ID
     */
    private async loadLanguage(languageId: string): Promise<Parser.Language | null> {
        if (!this.initialized || !this.parser) return null;
        if (this.languageMap.has(languageId)) {
            return this.languageMap.get(languageId) ?? null;
        }

        const wasmFile = LANGUAGE_PROFILES[languageId]?.wasmFile;
        if (!wasmFile) {
            if (!this.unmappedLanguagesLogged.has(languageId)) {
                this.unmappedLanguagesLogged.add(languageId);
                this.logger.info(`[AST] No WASM mapping for languageId=${languageId}`);
            }
            return null;
        }

        const wasmPath = path.join(this.extensionContext.extensionPath, 'dist', 'wasm', wasmFile);

        try {
            const lang = await Parser.Language.load(wasmPath);
            this.languageMap.set(languageId, lang);
            this.logger.info(`[AST] Loaded language WASM for ${languageId}: ${wasmFile}`);
            return lang;
        } catch (error) {
            this.logger.error(`[AST] WASM load failed for ${languageId} at ${wasmPath}: ${error instanceof Error ? error.message : String(error)}`);
            // 记录已处理，避免重复加载报错
            this.languageMap.set(languageId, null);
            return null;
        }
    }

    /**
     * 获取或创建编译后的 Query 对象
     */
    private getQuery(languageId: string, lang: Parser.Language): Parser.Query | null {
        if (this.queryCache.has(languageId)) {
            return this.queryCache.get(languageId) ?? null;
        }

        const querySource = LANGUAGE_PROFILES[languageId]?.query;
        if (!querySource) {
            this.queryCache.set(languageId, null);
            return null;
        }

        try {
            const query = lang.query(querySource);
            this.queryCache.set(languageId, query);
            this.logger.info(`[AST] Query compiled for ${languageId}`);
            return query;
        } catch (error) {
            this.logger.error(`[AST] Query compile failed for ${languageId}: ${error instanceof Error ? error.message : String(error)}`);
            this.queryCache.set(languageId, null);
            return null;
        }
    }

    /**
     * 获取（并按需缓存）文档整篇文本。
     * 真实 vscode.TextDocument 提供 uri/version；缺少这两个属性的调用方（如测试
     * mock）会得到空 key，从而不缓存（保证不同 mock 文档间不互相污染）。
     */
    private getDocumentText(document: vscode.TextDocument): string {
        const key = `${document.uri?.toString() ?? ''}@${document.version ?? -1}`;
        if (key !== '' && key === this.cachedDocKey) return this.cachedDocText;
        const text = document.getText();
        this.cachedDocKey = key;
        this.cachedDocText = text;
        return text;
    }

    /**
     * 快速文本级注释检测（同步，无 AST 开销）
     * 返回: true = 确定在注释中, false = 确定不在, null = 不确定需 AST
     */
    public isCursorInCommentFast(document: vscode.TextDocument, position: vscode.Position, languageId: string): boolean | null {
        const lineText = document.lineAt(position.line).text;
        const col = position.character;
        const textBeforeCursor = lineText.substring(0, col);

        // 行注释快速检测
        const profile = LANGUAGE_PROFILES[languageId];
        if (profile) {
            for (const pattern of profile.lineComments) {
                const idx = textBeforeCursor.indexOf(pattern);
                if (idx >= 0) {
                    // 检查注释标记前是否有未闭合的引号（简单启发式）
                    const before = textBeforeCursor.substring(0, idx);
                    if (!hasUnclosedQuote(before)) {
                        return true;
                    }
                }
            }

            // 块注释快速检测：光标是否在 open 和 close 之间（语言无块注释则跳过）
            if (profile.blockComments) {
                const [open, close] = profile.blockComments;
                const fullText = this.getDocumentText(document);
                const offset = document.offsetAt(position);
                // 用带 fromIndex 的 lastIndexOf 直接在游标前区间搜索，避免再复制一份子串
                const lastBlockOpen = fullText.lastIndexOf(open, Math.max(0, offset - 1));
                const lastBlockClose = fullText.lastIndexOf(close, Math.max(0, offset - 1));
                if (lastBlockOpen >= 0 && lastBlockOpen > lastBlockClose
                    && !this.markerLineHasUnclosedQuote(fullText, lastBlockOpen)) {
                    return true;
                }
            }
        }

        // 光标前只有空白，不在注释中
        if (textBeforeCursor.trim() === '') {
            return false;
        }

        return null; // 不确定，需要 AST 分析
    }

    /**
     * 核心检测函数：光标是否在注释或字符串中
     * 使用 tree-sitter Query API 匹配注释/字符串节点
     */
    public async isCursorInCommentOrString(document: vscode.TextDocument, position: vscode.Position): Promise<{ match: boolean, type: string | null }> {
        if (!this.initialized || !this.parser) return { match: false, type: null };

        const languageId = document.languageId;
        const lang = await this.loadLanguage(languageId);
        if (!lang) return { match: false, type: null };

        const query = this.getQuery(languageId, lang);
        if (!query) return { match: false, type: null };

        // 取消机制: 记录本次分析的 generation，后续若有更新的分析则丢弃结果
        const myGeneration = ++this.analysisGeneration;

        this.parser.setLanguage(lang);
        const text = this.getDocumentText(document);

        // 每次都全量解析，不复用上一次的 Tree。原因（巡检 C1，见 docs/adr/0003）：
        // 1) 增量解析必须先 tree.edit() 告知编辑器变更区间，本扩展没有把 contentChanges
        //    透传进来；缺 edit() 时 tree-sitter 会复用区间已失效的子树，实测在游标上方
        //    插入 3 行后，注释节点会退化成 "functio"@0:0 —— 判定直接错位。
        // 2) lastTree 是实例级单槽，切换文件/语言时必然跨语法复用，而这不抛异常
        //    （只得到一个 root=ERROR 的树），因此“失败降级全量解析”的 catch 分支永不触发。
        // 真增量（按 uri 持有 Tree + 正确 edit）成本可控，列为后续优化，不在“先保正确”这一步做。
        const tree = this.parser.parse(text);
        let result: { match: boolean; type: string | null } = { match: false, type: null };
        try {
            // 若已有更新的分析请求，丢弃本次结果
            if (myGeneration === this.analysisGeneration) {
                result = findCapture(query.matches(tree.rootNode), position.line, position.character);
            }
        } finally {
            // matches 里的 SyntaxNode 持有本棵树的内存，必须扫描完再释放
            tree.delete();
        }
        return result;
    }

    /**
     * 注释标记所在行、标记之前的引号是否未闭合。
     * 用于挡掉 `const re = "/*";` 这类“注释标记其实是字符串内容”的快路径假阳性：
     * 一旦本行引号不成对，快路径不下结论（返回 null），交给 AST 判定。
     */
    private markerLineHasUnclosedQuote(fullText: string, markerIndex: number): boolean {
        const lineStart = fullText.lastIndexOf('\n', markerIndex - 1) + 1;
        return hasUnclosedQuote(fullText.slice(lineStart, markerIndex));
    }

    /**
     * 释放所有资源。扩展停用时调用。
     */
    public dispose(): void {
        this.queryCache.forEach(q => q?.delete());
        this.queryCache.clear();
        this.languageMap.clear();
        this.parser?.delete();
        this.parser = null;
        this.initialized = false;
    }
}

/** 行内引号是否未闭合（成对出现视为已闭合） */
function hasUnclosedQuote(textBeforeMarker: string): boolean {
    const count = (re: RegExp) => (textBeforeMarker.match(re) || []).length;
    return count(/"/g) % 2 !== 0 || count(/'/g) % 2 !== 0 || count(/`/g) % 2 !== 0;
}

/** 在 Query 匹配结果中找出包含 (row, column) 的第一个捕获；无则视为代码 */
function findCapture(
    matches: Parser.QueryMatch[],
    row: number,
    column: number,
): { match: boolean; type: string | null } {
    for (const match of matches) {
        for (const capture of match.captures) {
            const node = capture.node;

            if (!containsPosition(node, row, column)) continue;

            // 注释特殊处理：光标在注释起始位置之前时，视为不在注释中
            const atOrBeforeCommentStart = capture.name === 'comment'
                && node.type.includes('comment')
                && row === node.startPosition.row
                && column <= node.startPosition.column;
            if (atOrBeforeCommentStart) continue;

            return { match: true, type: capture.name };
        }
    }
    return { match: false, type: null };
}

/** 节点的 [start, end) 区间（按行/列）是否包含给定位置 */
function containsPosition(node: Parser.SyntaxNode, row: number, column: number): boolean {
    const { row: startRow, column: startCol } = node.startPosition;
    const { row: endRow, column: endCol } = node.endPosition;

    if (row > startRow && row < endRow) return true;
    if (row === startRow && row === endRow) return column >= startCol && column < endCol;
    if (row === startRow) return column >= startCol;
    if (row === endRow) return column < endCol;
    return false;
}

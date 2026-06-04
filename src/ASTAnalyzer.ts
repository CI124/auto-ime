import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import * as path from 'path';
import { LogSink } from './logger';

/**
 * 【开发者必读】：WASM 文件存放与构建说明
 * 
 * 1. web-tree-sitter 需要对应的 language wasm 文件 (例如: tree-sitter-javascript.wasm, tree-sitter-typescript.wasm, tree-sitter-python.wasm)。
 * 2. 在实际发布时，你需要从 npm 获取对应的包 (例如 `tree-sitter-javascript`)，
 *    然后将其中的 `.wasm` 文件拷贝到扩展的输出目录 (通常是本项目的 ./wasm 文件夹)。
 * 3. 本实现动态映射 VSCode languageId 到 wasm 文件名称。
 * 4. 如果遇到找不到 wasm 的情况，语法树解析会平滑降级，返回 false，此时不会触发任何输入法切换。
 */

export class ASTAnalyzer {
    private parser: Parser | null = null;
    private initialized = false;
    private languageMap = new Map<string, Parser.Language | null>();
    private extensionContext: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private logger: LogSink;

    // 增量解析: 缓存上一次的 Tree，供 parser.parse(text, oldTree) 使用
    private lastTree: Parser.Tree | null = null;
    // 取消机制: 每次分析递增，过期的解析结果会被丢弃
    private analysisGeneration = 0;

    // WASM 文件映射字典：languageId -> wasm 文件名
    private readonly WASM_FILE_MAPPING: Record<string, string> = {
        'typescript': 'tree-sitter-typescript.wasm',
        'typescriptreact': 'tree-sitter-typescript.wasm',
        'javascript': 'tree-sitter-javascript.wasm',
        'javascriptreact': 'tree-sitter-javascript.wasm',
        'python': 'tree-sitter-python.wasm',
        'go': 'tree-sitter-go.wasm',
        'rust': 'tree-sitter-rust.wasm',
        'c': 'tree-sitter-c.wasm',
        'cpp': 'tree-sitter-cpp.wasm',
        'html': 'tree-sitter-html.wasm',
        'css': 'tree-sitter-css.wasm',
        'lua': 'tree-sitter-lua.wasm',
        'java': 'tree-sitter-java.wasm',
        'kotlin': 'tree-sitter-kotlin.wasm',
        'shellscript': 'tree-sitter-bash.wasm'
    };

    // Tree-sitter Query 模式：捕获注释和字符串节点
    private readonly COMMENT_QUERY: Record<string, string> = {
        'javascript': `(comment) @comment\n(string) @comment\n(template_string) @comment`,
        'javascriptreact': `(comment) @comment\n(string) @comment\n(template_string) @comment`,
        'typescript': `(comment) @comment\n(string) @comment\n(template_string) @comment`,
        'typescriptreact': `(comment) @comment\n(string) @comment\n(template_string) @comment`,
        'python': `(comment) @comment\n(string) @comment`,
        'go': `(comment) @comment\n(interpreted_string_literal) @comment\n(raw_string_literal) @comment`,
        'rust': `(line_comment) @comment\n(block_comment) @comment\n(string_literal) @comment\n(raw_string_literal) @comment`,
        'c': `(comment) @comment\n(string_literal) @comment`,
        'cpp': `(comment) @comment\n(string_literal) @comment\n(raw_string_literal) @comment`,
        'html': `(comment) @comment`,
        'css': `(comment) @comment`,
        'lua': `(comment) @comment\n(string) @comment`,
        'java': `(comment) @comment\n(string_literal) @comment`,
        'kotlin': `(comment) @comment\n(string_literal) @comment`,
        'shellscript': `(comment) @comment\n(string) @comment\n(raw_string) @comment\n(heredoc_body) @comment`
    };

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
            const cached = this.languageMap.get(languageId) ?? null;
            if (!cached) {
            }
            return cached;
        }

        const wasmFile = this.WASM_FILE_MAPPING[languageId];
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

        const querySource = this.COMMENT_QUERY[languageId];
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
     * 快速文本级注释检测（同步，无 AST 开销）
     * 返回: true = 确定在注释中, false = 确定不在, null = 不确定需 AST
     */
    public isCursorInCommentFast(document: vscode.TextDocument, position: vscode.Position, languageId: string): boolean | null {
        const lineText = document.lineAt(position.line).text;
        const col = position.character;
        const textBeforeCursor = lineText.substring(0, col);

        // 行注释快速检测
        const lineCommentPatterns: Record<string, string[]> = {
            'typescript': ['//'],
            'typescriptreact': ['//'],
            'javascript': ['//'],
            'javascriptreact': ['//'],
            'python': ['#'],
            'go': ['//'],
            'rust': ['//'],
            'c': ['//'],
            'cpp': ['//'],
            'html': ['<!--'],
            'css': ['//'],
            'lua': ['--'],
            'java': ['//'],
            'kotlin': ['//'],
            'shellscript': ['#'],
        };

        const patterns = lineCommentPatterns[languageId];
        if (patterns) {
            for (const pattern of patterns) {
                const idx = textBeforeCursor.indexOf(pattern);
                if (idx >= 0) {
                    // 检查注释标记前是否有未闭合的引号（简单启发式）
                    const before = textBeforeCursor.substring(0, idx);
                    const dq = (before.match(/"/g) || []).length;
                    const sq = (before.match(/'/g) || []).length;
                    const bq = (before.match(/`/g) || []).length;
                    if (dq % 2 === 0 && sq % 2 === 0 && bq % 2 === 0) {
                        return true;
                    }
                }
            }
        }

        // 块注释快速检测：光标是否在 /* 和 */ 之间
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const beforeText = fullText.substring(0, offset);
        const lastBlockOpen = beforeText.lastIndexOf('/*');
        const lastBlockClose = beforeText.lastIndexOf('*/');
        if (lastBlockOpen >= 0 && lastBlockOpen > lastBlockClose) {
            return true;
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
        const text = document.getText();

        let tree: Parser.Tree;
        try {
            // 增量解析: 利用上一次的 Tree 仅重新解析变更部分
            tree = this.parser.parse(text, this.lastTree ?? undefined);
        } catch (error) {
            // 增量解析失败时降级为全量解析
            try {
                tree = this.parser.parse(text);
            } catch {
                return { match: false, type: null };
            }
        }

        // 释放旧树，缓存新树
        this.lastTree?.delete();
        this.lastTree = tree;

        // 若已有更新的分析请求，丢弃本次结果
        if (myGeneration !== this.analysisGeneration) {
            return { match: false, type: null };
        }

        const row = position.line;
        const column = position.character;

        // 使用 Query 匹配所有注释/字符串节点
        const matches = query.matches(tree.rootNode);

        for (const match of matches) {
            for (const capture of match.captures) {
                const node = capture.node;
                const startRow = node.startPosition.row;
                const startCol = node.startPosition.column;
                const endRow = node.endPosition.row;
                const endCol = node.endPosition.column;

                // 检查光标是否在节点范围内
                let inRange = false;
                if (row > startRow && row < endRow) {
                    inRange = true;
                } else if (row === startRow && row === endRow) {
                    inRange = column >= startCol && column < endCol;
                } else if (row === startRow) {
                    inRange = column >= startCol;
                } else if (row === endRow) {
                    inRange = column < endCol;
                }

                if (!inRange) continue;

                // 注释特殊处理：光标在注释起始位置之前时，视为不在注释中
                if (capture.name === 'comment' && node.type.includes('comment')) {
                    if (row === startRow && column <= startCol) {
                        continue;
                    }
                }

                return { match: true, type: capture.name };
            }
        }

        return { match: false, type: null };
    }

    /**
     * 释放所有资源。扩展停用时调用。
     */
    public dispose(): void {
        this.lastTree?.delete();
        this.lastTree = null;
        this.queryCache.forEach(q => q?.delete());
        this.queryCache.clear();
        this.languageMap.clear();
        this.parser?.delete();
        this.parser = null;
        this.initialized = false;
    }
}

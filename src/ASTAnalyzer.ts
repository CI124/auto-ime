import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import * as path from 'path';

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
        'css': 'tree-sitter-css.wasm'
    };

    // 目标节点映射字典配置：配置不同语言中的注释或字符串对应名称
    private readonly TARGET_NODE_TYPES: Record<string, string[]> = {
        'javascript': ['comment', 'string', 'template_string'],
        'javascriptreact': ['comment', 'string', 'template_string'],
        'typescript': ['comment', 'string', 'template_string'],
        'typescriptreact': ['comment', 'string', 'template_string'],
        'python': ['comment', 'string'],
        'go': ['comment', 'interpreted_string_literal', 'raw_string_literal'],
        'rust': ['line_comment', 'block_comment', 'string_literal', 'raw_string_literal'],
        'c': ['comment', 'string_literal'],
        'cpp': ['comment', 'string_literal', 'string_content', 'raw_string_literal'],
        'html': ['comment'],
        'css': ['comment']
    };

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.extensionContext = context;
        this.outputChannel = outputChannel;
    }

    private logInfo(message: string): void {
        console.log(message);
        this.outputChannel.appendLine(message);
    }

    private logError(message: string, error?: unknown): void {
        console.error(message, error);
        const errorMessage = error instanceof Error ? error.message : error ? String(error) : '';
        this.outputChannel.appendLine(errorMessage ? `${message} ${errorMessage}` : message);
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
            this.logInfo('Tree-sitter initialized successfully.');
        } catch (error) {
            this.logError('Failed to initialize Tree-sitter', error);
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
                this.logInfo(`[AST] Language cache is null for ${languageId}, skipping.`);
            }
            return cached;
        }

        const wasmFile = this.WASM_FILE_MAPPING[languageId];
        if (!wasmFile) {
            this.logInfo(`[AST] No WASM mapping for languageId=${languageId}`);
            return null;
        }

        const wasmPath = path.join(this.extensionContext.extensionPath, 'out', 'wasm', wasmFile);
        
        try {
            const lang = await Parser.Language.load(wasmPath);
            this.languageMap.set(languageId, lang);
            this.logInfo(`[AST] Loaded language WASM for ${languageId}: ${wasmFile}`);
            return lang;
        } catch (error) {
            this.logError(`[AST] WASM load failed for ${languageId} at ${wasmPath}. AST parsing disabled for this language.`, error);
            // 记录已处理，避免重复加载报错
            this.languageMap.set(languageId, null);
            return null;
        }
    }

    /**
     * 核心检测函数：光标是否在注释或字符串中
     * 使用增量解析提高性能
     */
    public async isCursorInCommentOrString(document: vscode.TextDocument, position: vscode.Position): Promise<{ match: boolean, type: string | null }> {
        if (!this.initialized || !this.parser) return { match: false, type: null };

        const languageId = document.languageId;
        const lang = await this.loadLanguage(languageId);
        if (!lang) return { match: false, type: null };

        const targetTypes = this.TARGET_NODE_TYPES[languageId];
        if (!targetTypes) return { match: false, type: null };

        this.parser.setLanguage(lang);
        const text = document.getText();

        // 全量解析（WASM 增量解析有 bug，全量解析实测 0.01ms 足够快）
        let tree: Parser.Tree;
        try {
            tree = this.parser.parse(text);
        } catch (error) {
            return { match: false, type: null };
        }

        // tree-sitter WASM 使用字符偏移，直接用 position.character
        const row = position.line;
        const column = position.character;

        // 用 namedDescendantForPosition 定位
        let cursorNode = tree.rootNode.namedDescendantForPosition({ row, column });

        // 如果返回根节点（光标在文本末尾等边界位置），尝试用前一个位置
        if (!cursorNode || cursorNode.type === tree.rootNode.type) {
            if (column > 0) {
                cursorNode = tree.rootNode.namedDescendantForPosition({ row, column: column - 1 });
            }
            if (!cursorNode || cursorNode.type === tree.rootNode.type) {
                return { match: false, type: null };
            }
        }

        // 向上遍历 AST 确认是否为注释或字符串
        let currentNode: Parser.SyntaxNode | null = cursorNode;
        while (currentNode) {
            const type = currentNode.type;
            if (targetTypes.includes(type) || targetTypes.some(t => type.includes(t))) {
                // 特殊处理：光标在注释节点最开头时，视为不在注释中
                // 用户可能打算在 // 或 /* 前面写代码
                // 字符串不做此处理，因为光标在引号上通常意味着要编辑字符串
                if (type.includes('comment')) {
                    const nodeStartRow = currentNode.startPosition.row;
                    const nodeStartCol = currentNode.startPosition.column;
                    // 光标在注释起始位置之前时，视为不在注释中
                    // 例如缩进空白处：    // comment，光标在 // 前面的空白
                    if (row === nodeStartRow && column <= nodeStartCol) {
                        return { match: false, type: null };
                    }
                }
                return { match: true, type: type };
            }
            currentNode = currentNode.parent;
        }

        return { match: false, type: null };
    }
}

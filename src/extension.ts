import * as vscode from 'vscode';
import { createImeManager, IIMEManager } from './IMEManager';
import { ASTAnalyzer } from './ASTAnalyzer';
import { IMEStateManager } from './IMEStateManager';

let astAnalyzer: ASTAnalyzer;
let documentDebounceTimer: NodeJS.Timeout | null = null;
let selectionDebounceTimer: NodeJS.Timeout | null = null;
let modeDetectionTimer: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let imeManager: IIMEManager;
let imeStateManager: IMEStateManager;

// 当前输入法状态
let currentIMEMode: 'en' | 'zh' = 'en';
// 是否为 Vim 模式（启动时检测，运行期间不变）
let isVimMode = false;
// 上一次的光标样式，用于检测 Insert -> Normal 模式切换（仅 Vim 模式）
let lastCursorStyle: vscode.TextEditorCursorStyle | undefined;

/**
 * 更新状态栏显示
 */
function updateStatusBar(mode: 'en' | 'zh') {
    currentIMEMode = mode;
    if (mode === 'zh') {
        statusBarItem.text = '$(keyboard) 中';
        statusBarItem.tooltip = '当前: 中文输入法 (点击切换到英文)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = '$(keyboard) EN';
        statusBarItem.tooltip = '当前: 英文输入法 (点击切换到中文)';
        statusBarItem.backgroundColor = undefined;
    }
}

/**
 * 强制切换到英文（ESC 时调用）
 */
function forceEnglish() {
    if (currentIMEMode !== 'en') {
        imeManager.switchToEnglish();
        updateStatusBar('en');
        outputChannel.appendLine('[ESC] Forced switch to English');
    }
    // 重置手动覆盖模式
    imeStateManager.resetManualOverride();
}

/**
 * 切换输入法状态（用户手动触发）
 */
function toggleIME() {
    if (currentIMEMode === 'zh') {
        imeManager.switchToEnglish();
        updateStatusBar('en');
        outputChannel.appendLine('[StatusBar] User toggled to English');
    } else {
        imeManager.switchToChinese();
        updateStatusBar('zh');
        outputChannel.appendLine('[StatusBar] User toggled to Chinese');
    }
    // 标记为自动切换，避免被误判为用户手动切换
    imeStateManager.markAutoSwitch();
}

export async function activate(context: vscode.ExtensionContext) {
    // 引入扩展专属输出通道
    outputChannel = vscode.window.createOutputChannel("Auto Vim IME");
    outputChannel.appendLine('Extension auto-vim-ime is now active!');
    context.subscriptions.push(outputChannel);

    // 检测 Vim 环境，决定运行模式
    isVimMode = !!vscode.extensions.getExtension('vscodevim.vim')?.isActive;
    outputChannel.appendLine(`[Mode] ${isVimMode ? 'Vim 模式' : '普通模式'}`);

    // 初始化 IME 管理器并输出检测日志
    imeManager = createImeManager(outputChannel);

    // 初始化 IME 状态管理器（监听用户手动切换）
    imeStateManager = new IMEStateManager({
        info: (msg) => outputChannel.appendLine(msg),
        error: (msg) => outputChannel.appendLine(msg)
    });
    await imeStateManager.startListening();

    // 监听手动切换，同步更新状态栏
    imeStateManager.setOnChangeCallback((newIME: string) => {
        const isEnglish = newIME.includes('keyboard') || newIME.includes('xkb') || newIME.includes('eng');
        updateStatusBar(isEnglish ? 'en' : 'zh');
        outputChannel.appendLine(`[StatusBar] 手动切换同步: ${newIME} → ${isEnglish ? 'EN' : '中'}`);
    });

    // ==========================================
    // 状态栏：显示当前输入法状态
    // ==========================================
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'auto-vim-ime.toggleIME';
    updateStatusBar('en');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 注册状态栏点击切换命令
    const toggleCommand = vscode.commands.registerCommand('auto-vim-ime.toggleIME', () => {
        toggleIME();
    });
    context.subscriptions.push(toggleCommand);

    // 初始化 AST 分析器
    astAnalyzer = new ASTAnalyzer(context, outputChannel);
    await astAnalyzer.init();
    outputChannel.appendLine('AST Analyzer initialized.');

    // 核心分析函数：检测光标上下文并切换输入法
    async function analyzeAndSwitch(editor: vscode.TextEditor) {
        // 如果用户手动切换了输入法，暂停自动切换
        if (imeStateManager.isManualOverride()) {
            outputChannel.appendLine('[AutoSwitch] 手动覆盖模式，跳过自动切换');
            return;
        }

        const document = editor.document;
        const position = editor.selections[0].active;

        // 快速路径：基于文本的注释检测（同步，无 AST 开销）
        const fastResult = astAnalyzer.isCursorInCommentFast(document, position, document.languageId);
        if (fastResult === true) {
            if (currentIMEMode !== 'zh') {
                outputChannel.appendLine(`[AutoSwitch] 快速检测: 注释区域 line=${position.line}, char=${position.character}`);
                imeStateManager.markAutoSwitch();
                imeManager.switchToChinese();
                updateStatusBar('zh');
            }
            return;
        }

        // 完整 AST 分析
        outputChannel.appendLine(`[AutoSwitch] AST 分析: line=${position.line}, char=${position.character}`);
        const astResult = await astAnalyzer.isCursorInCommentOrString(document, position);

        if (astResult.match) {
            if (currentIMEMode !== 'zh') {
                outputChannel.appendLine(`[AutoSwitch] 检测到 ${astResult.type}，切换到中文`);
                imeStateManager.markAutoSwitch();
                imeManager.switchToChinese();
                updateStatusBar('zh');
            }
        } else {
            if (currentIMEMode !== 'en') {
                outputChannel.appendLine('[AutoSwitch] 代码区域，切换到英文');
                imeStateManager.markAutoSwitch();
                imeManager.switchToEnglish();
                updateStatusBar('en');
            }
        }
    }

    // 检查是否在 Insert 模式（仅 Vim 模式有意义）
    function isInInsertMode(editor: vscode.TextEditor): boolean {
        return editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line;
    }

    // 文档变化时的分析调度（30ms 防抖，更快响应输入）
    function scheduleAnalyzeFromDocument() {
        if (documentDebounceTimer) {
            clearTimeout(documentDebounceTimer);
        }
        documentDebounceTimer = setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            // Vim 模式仅 Insert 模式下分析，普通模式始终分析
            if (isVimMode && !isInInsertMode(editor)) return;
            analyzeAndSwitch(editor);
        }, 30);
    }

    // 选择变化时的分析调度（50ms 防抖）
    function scheduleAnalyzeFromSelection() {
        if (selectionDebounceTimer) {
            clearTimeout(selectionDebounceTimer);
        }
        selectionDebounceTimer = setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            // Vim 模式仅 Insert 模式下分析，普通模式始终分析
            if (isVimMode && !isInInsertMode(editor)) return;
            analyzeAndSwitch(editor);
        }, 50);
    }

    // ==========================================
    // Vim 模式专属：ESC 劫持 + 光标样式轮询
    // ==========================================
    if (isVimMode) {
        // ESC 劫持：退回 Normal 模式的同时强制切换英文
        const escapeCommand = vscode.commands.registerCommand('auto-vim-ime.escape', () => {
            outputChannel.appendLine(`[Escape] Intercepted Esc key in Insert Mode`);
            forceEnglish();
            vscode.commands.executeCommand('extension.vim_escape');
        });
        context.subscriptions.push(escapeCommand);

        // 光标样式轮询：检测 Normal → Insert 模式切换
        function checkModeChange() {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            if (lastCursorStyle === vscode.TextEditorCursorStyle.Block &&
                editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line) {
                stopModeDetection();
                lastCursorStyle = editor.options.cursorStyle;
                outputChannel.appendLine('[ModeDetect] Normal → Insert 检测到，触发分析');
                analyzeAndSwitch(editor);
            }
        }

        function startModeDetection() {
            if (modeDetectionTimer) return;
            checkModeChange();
            modeDetectionTimer = setInterval(checkModeChange, 20);
        }

        function stopModeDetection() {
            if (modeDetectionTimer) {
                clearInterval(modeDetectionTimer);
                modeDetectionTimer = null;
            }
        }

        // 初始化 lastCursorStyle
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            lastCursorStyle = activeEditor.options.cursorStyle;
            if (lastCursorStyle !== vscode.TextEditorCursorStyle.Line) {
                startModeDetection();
            }
        }

        // 监听编辑器切换
        const editorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                lastCursorStyle = editor.options.cursorStyle;
                if (lastCursorStyle !== vscode.TextEditorCursorStyle.Line) {
                    startModeDetection();
                } else {
                    stopModeDetection();
                }
            }
        });
        context.subscriptions.push(editorChange);

        // 光标/选择变化：Vim 模式专属逻辑
        const selectionChange = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!e.textEditor.document) return;

            const currentCursorStyle = e.textEditor.options.cursorStyle;

            // 检测 Insert -> Normal 模式切换
            if (lastCursorStyle === vscode.TextEditorCursorStyle.Line &&
                currentCursorStyle === vscode.TextEditorCursorStyle.Block) {
                forceEnglish();
                startModeDetection();
            }
            lastCursorStyle = currentCursorStyle;

            // 只在 Insert 模式下分析
            if (!isInInsertMode(e.textEditor)) return;
            stopModeDetection();
            scheduleAnalyzeFromSelection();
        });
        context.subscriptions.push(selectionChange);

        // 文档变化：Vim 模式仅 Insert 模式下分析
        const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== e.document) return;
            if (!isInInsertMode(editor)) return;
            scheduleAnalyzeFromDocument();
        });
        context.subscriptions.push(documentChange);

    } else {
        // ==========================================
        // 普通模式：全局分析，无需 Insert 模式检测
        // ==========================================

        // 光标/选择变化：始终分析
        const selectionChange = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!e.textEditor.document) return;
            scheduleAnalyzeFromSelection();
        });
        context.subscriptions.push(selectionChange);

        // 文档变化：始终分析
        const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== e.document) return;
            scheduleAnalyzeFromDocument();
        });
        context.subscriptions.push(documentChange);
    }

    outputChannel.appendLine(`[Mode] ${isVimMode ? 'Vim' : 'Normal'} mode listeners registered. Extension is ready.`);
}

export function deactivate() {
    if (documentDebounceTimer) {
        clearTimeout(documentDebounceTimer);
    }
    if (selectionDebounceTimer) {
        clearTimeout(selectionDebounceTimer);
    }
    if (modeDetectionTimer) {
        clearInterval(modeDetectionTimer);
    }
    if (imeStateManager) {
        imeStateManager.stopListening();
    }
}

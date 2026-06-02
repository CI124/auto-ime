import * as vscode from 'vscode';
import { createImeManager, IIMEManager } from './IMEManager';
import { ASTAnalyzer } from './ASTAnalyzer';
import { IMEStateManager } from './IMEStateManager';

let astAnalyzer: ASTAnalyzer;
let debounceTimer: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let imeManager: IIMEManager;
let imeStateManager: IMEStateManager;

// 当前输入法状态
let currentIMEMode: 'en' | 'zh' = 'en';
// 上一次的光标样式，用于检测 Insert -> Normal 模式切换
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
    imeManager.switchToEnglish();
    updateStatusBar('en');
    outputChannel.appendLine('[ESC] Forced switch to English');
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

    // ==========================================
    // 监听：Esc 劫持，退回 Normal 模式的同时强制切换英文
    // ==========================================
    const escapeCommand = vscode.commands.registerCommand('auto-vim-ime.escape', () => {
        outputChannel.appendLine(`[Escape] Intercepted Esc key in Insert Mode`);
        forceEnglish();
        vscode.commands.executeCommand('extension.vim_escape');
    });

    context.subscriptions.push(escapeCommand);

    // 初始化 lastCursorStyle：从当前活动编辑器获取
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        lastCursorStyle = activeEditor.options.cursorStyle;
    }

    // 监听编辑器切换，更新 lastCursorStyle
    const editorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            lastCursorStyle = editor.options.cursorStyle;
        }
    });
    context.subscriptions.push(editorChange);

    // 核心分析函数：检测光标上下文并切换输入法
    async function analyzeAndSwitch(editor: vscode.TextEditor) {
        // 如果用户手动切换了输入法，暂停自动切换
        if (imeStateManager.isManualOverride()) {
            outputChannel.appendLine('[AutoSwitch] 手动覆盖模式，跳过自动切换');
            return;
        }

        const document = editor.document;
        const position = editor.selections[0].active;

        outputChannel.appendLine(`[AutoSwitch] 分析位置: line=${position.line}, char=${position.character}`);
        const astResult = await astAnalyzer.isCursorInCommentOrString(document, position);

        if (astResult.match) {
            outputChannel.appendLine(`[AutoSwitch] 检测到 ${astResult.type}，切换到中文`);
            imeStateManager.markAutoSwitch();
            imeManager.switchToChinese();
            updateStatusBar('zh');
        } else {
            outputChannel.appendLine('[AutoSwitch] 代码区域，切换到英文');
            imeStateManager.markAutoSwitch();
            imeManager.switchToEnglish();
            updateStatusBar('en');
        }
    }

    // 检查是否在 Insert 模式
    function isInInsertMode(editor: vscode.TextEditor): boolean {
        return editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line;
    }

    // 带防抖的分析调度
    function scheduleAnalyze(editor: vscode.TextEditor) {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => analyzeAndSwitch(editor), 50);
    }

    // ==========================================
    // 监听：光标或选择区域变动，智能切换输入法
    // ==========================================
    const selectionChange = vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!e.textEditor.document) return;

        const currentCursorStyle = e.textEditor.options.cursorStyle;

        // 检测 Insert -> Normal 模式切换（光标从 Line 变为 Block）
        if (lastCursorStyle === vscode.TextEditorCursorStyle.Line &&
            currentCursorStyle === vscode.TextEditorCursorStyle.Block) {
            forceEnglish();
        }
        lastCursorStyle = currentCursorStyle;

        // 只在 Insert 模式下处理
        if (!isInInsertMode(e.textEditor)) return;

        scheduleAnalyze(e.textEditor);
    });
    context.subscriptions.push(selectionChange);

    // ==========================================
    // 监听：文档内容变化（输入文字时触发）
    // 解决输入 // 开始注释时不触发的问题
    // ==========================================
    const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== e.document) return;
        if (!isInInsertMode(editor)) return;
        scheduleAnalyze(editor);
    });
    context.subscriptions.push(documentChange);

    outputChannel.appendLine('All event listeners registered. Extension is ready.');
}

export function deactivate() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    if (imeStateManager) {
        imeStateManager.stopListening();
    }
}

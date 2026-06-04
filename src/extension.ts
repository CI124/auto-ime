import * as vscode from 'vscode';
import { createImeManager, IIMEManager } from './IMEManager';
import { ASTAnalyzer } from './ASTAnalyzer';
import { IMEStateManager } from './IMEStateManager';
import { createLogger, LogSink } from './logger';

let astAnalyzer: ASTAnalyzer;
let analyzeDebounceTimer: NodeJS.Timeout | null = null;
let modeDetectionTimer: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let imeManager: IIMEManager;
let imeStateManager: IMEStateManager;
let activeDisposables: vscode.Disposable[] = [];
let logger: LogSink | null = null;

// 会话级标记：英语键盘缺失提示只显示一次
let englishKeyboardWarningShown = false;

// 当前输入法状态
let currentIMEMode: 'en' | 'zh' = 'en';
// 是否为 Vim 模式（支持延迟检测 Vim 扩展激活）
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
        logger.info('[ESC] Forced switch to English');
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
        logger.info('[StatusBar] User toggled to English');
    } else {
        imeManager.switchToChinese();
        updateStatusBar('zh');
        logger.info('[StatusBar] User toggled to Chinese');
    }
    // 立即阻止自动分析，避免 10ms debounce 后覆盖用户操作
    imeStateManager.markManualSwitch();
}

export async function activate(context: vscode.ExtensionContext) {
    try {
    // 引入扩展专属输出通道
    outputChannel = vscode.window.createOutputChannel("Auto IME");
    context.subscriptions.push(outputChannel);

    // 创建日志文件（扩展存储目录/auto-ime.log）
    const logDir = context.globalStorageUri.fsPath;
    const logFilePath = require('path').join(logDir, 'auto-ime.log');
    try { require('fs').mkdirSync(logDir, { recursive: true }); } catch {}
    // 清空旧日志
    try { require('fs').writeFileSync(logFilePath, '', 'utf-8'); } catch {}

    // 创建统一 Logger
    logger = createLogger('Extension', outputChannel, logFilePath);

    logger.info('Extension auto-ime is now active!');

    // 初始化 IME 管理器并输出检测日志
    imeManager = createImeManager(outputChannel, logFilePath);

    // Windows: 检查英语键盘是否就绪，未就绪时提示用户
    if (process.platform === 'win32' && !englishKeyboardWarningShown &&
        'isReady' in imeManager && !(imeManager as any).isReady()) {
        englishKeyboardWarningShown = true;
        logger.warn('English keyboard layout not found, showing user guidance');
        vscode.window.showInformationMessage(
            'Auto IME 需要系统安装英语(美国)键盘布局才能正常工作。请在 Windows 设置 > 时间和语言 > 语言 中添加英语(美国)。',
            '打开设置'
        ).then(selection => {
            if (selection === '打开设置') {
                vscode.env.openExternal(vscode.Uri.parse('ms-settings:regionlanguage'));
            }
        });
    }

    // 初始化 IME 状态管理器（监听用户手动切换）
    imeStateManager = new IMEStateManager(logger);
    await imeStateManager.startListening();

    // 监听手动切换，同步更新状态栏
    imeStateManager.setOnChangeCallback((newIME: string) => {
        const isEnglish = newIME.includes('keyboard') || newIME.includes('xkb') || newIME.includes('eng');
        updateStatusBar(isEnglish ? 'en' : 'zh');
        logger.info(`[StatusBar] Manual switch sync: ${newIME} → ${isEnglish ? 'EN' : 'ZH'}`);
    });

    // ==========================================
    // 状态栏：显示当前输入法状态
    // ==========================================
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'auto-ime.toggleIME';
    updateStatusBar('en');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 注册状态栏点击切换命令
    const toggleCommand = vscode.commands.registerCommand('auto-ime.toggleIME', () => {
        toggleIME();
    });
    context.subscriptions.push(toggleCommand);

    // 初始化 AST 分析器
    const astLogger = createLogger('ASTAnalyzer', outputChannel, logFilePath);
    astAnalyzer = new ASTAnalyzer(context, outputChannel, astLogger);
    await astAnalyzer.init();
    logger.info('AST Analyzer initialized.');

    // 核心分析函数：检测光标上下文并切换输入法
    async function analyzeAndSwitch(editor: vscode.TextEditor) {
        const document = editor.document;
        const position = editor.selections[0].active;
        const cursor = `L${position.line + 1}:${position.character}`;
        const lang = document.languageId;
        const vimMode = isVimMode ? (isInInsertMode(editor) ? 'I' : 'N') : '-';

        // 手动覆盖模式：光标移动到不同行时恢复自动分析
        if (imeStateManager.isManualOverride()) {
            if (imeStateManager.isDifferentPosition(position.line)) {
                logger.info(`[${cursor}] ${lang} vim=${vimMode} → manual override resume`);
                imeStateManager.resetManualOverride();
            } else {
                return; // 同行不输出日志
            }
        }

        imeStateManager.updatePosition(position.line, position.character);

        // 快速路径：基于文本的注释检测（同步，无 AST 开销）
        const fastResult = astAnalyzer.isCursorInCommentFast(document, position, lang);
        if (fastResult === true) {
            if (currentIMEMode !== 'zh') {
                logger.info(`[${cursor}] ${lang} vim=${vimMode} → comment (fast) → switch to ZH`);
                imeStateManager.markAutoSwitch();
                imeManager.switchToChinese();
                updateStatusBar('zh');
            }
            return;
        }

        // 完整 AST 分析
        const astResult = await astAnalyzer.isCursorInCommentOrString(document, position);

        if (astResult.match) {
            if (currentIMEMode !== 'zh') {
                logger.info(`[${cursor}] ${lang} vim=${vimMode} → ${astResult.type} → switch to ZH`);
                imeStateManager.markAutoSwitch();
                imeManager.switchToChinese();
                updateStatusBar('zh');
            }
        } else {
            if (currentIMEMode !== 'en') {
                logger.info(`[${cursor}] ${lang} vim=${vimMode} → code → switch to EN`);
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

    // 统一分析调度（动态防抖: 根据文件大小调整延迟）
    function scheduleAnalyze() {
        if (analyzeDebounceTimer) {
            clearTimeout(analyzeDebounceTimer);
        }
        const editor = vscode.window.activeTextEditor;
        const lineCount = editor?.document.lineCount ?? 0;
        // 小文件 (<500行): 10ms | 中文件 (500-5000行): 30ms | 大文件 (>5000行): 60ms
        const delay = lineCount > 5000 ? 60 : lineCount > 500 ? 30 : 10;
        analyzeDebounceTimer = setTimeout(() => {
            if (!editor) return;
            if (isVimMode && !isInInsertMode(editor)) return;
            analyzeAndSwitch(editor);
        }, delay);
    }

    // ==========================================
    // 注册模式专属监听器
    // ==========================================

    function registerNormalListeners(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        const selectionChange = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!e.textEditor.document) return;

            // 检测光标变为 Block → 可能是 Vim 延迟加载，双向验证
            if (!isVimMode &&
                e.textEditor.options.cursorStyle === vscode.TextEditorCursorStyle.Block) {
                if (isVimVerified()) {
                    switchToVimMode();
                    return;
                }
            }

            scheduleAnalyze();
        });
        disposables.push(selectionChange);

        const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== e.document) return;
            scheduleAnalyze();
        });
        disposables.push(documentChange);

        // 监听光标样式变化（比轮询更精确）
        const optionsChange = vscode.window.onDidChangeTextEditorOptions((e) => {
            if (!isVimMode &&
                e.textEditor.options.cursorStyle === vscode.TextEditorCursorStyle.Block) {
                if (isVimVerified()) {
                    switchToVimMode();
                    return;
                }
            }
            scheduleAnalyze();
        });
        disposables.push(optionsChange);

        return disposables;
    }

    function registerVimListeners(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        // ESC 劫持：退回 Normal 模式的同时强制切换英文
        const escapeCommand = vscode.commands.registerCommand('auto-ime.escape', () => {
            forceEnglish();
            vscode.commands.executeCommand('extension.vim_escape');
        });
        disposables.push(escapeCommand);

        // 光标样式轮询：检测 Normal → Insert 模式切换
        function checkModeChange() {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            // 不依赖 lastCursorStyle，直接检测当前是否为 Insert 模式（Line 光标）
            if (editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line) {
                stopModeDetection();
                lastCursorStyle = editor.options.cursorStyle;
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
        disposables.push(editorChange);

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
            scheduleAnalyze();
        });
        disposables.push(selectionChange);

        // 文档变化：Vim 模式仅 Insert 模式下分析
        const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== e.document) return;
            if (!isInInsertMode(editor)) return;
            scheduleAnalyze();
        });
        disposables.push(documentChange);

        // 监听光标样式变化：精确检测 Normal → Insert 切换（替代轮询）
        const optionsChange = vscode.window.onDidChangeTextEditorOptions((e) => {
            const currentCursor = e.textEditor.options.cursorStyle;
            if (lastCursorStyle === vscode.TextEditorCursorStyle.Block &&
                currentCursor === vscode.TextEditorCursorStyle.Line) {
                // Normal → Insert
                stopModeDetection();
                lastCursorStyle = currentCursor;
                analyzeAndSwitch(e.textEditor);
            } else if (lastCursorStyle === vscode.TextEditorCursorStyle.Line &&
                       currentCursor === vscode.TextEditorCursorStyle.Block) {
                // Insert → Normal
                forceEnglish();
                startModeDetection();
                lastCursorStyle = currentCursor;
            }
        });
        disposables.push(optionsChange);

        return disposables;
    }

    // 双向验证：isActive + 光标为 Block
    function isVimVerified(): boolean {
        const vimActive = !!vscode.extensions.getExtension('vscodevim.vim')?.isActive;
        const editor = vscode.window.activeTextEditor;
        const cursorIsBlock = editor?.options.cursorStyle === vscode.TextEditorCursorStyle.Block;
        return vimActive && !!cursorIsBlock;
    }

    function switchToVimMode() {
        isVimMode = true;
        logger.info('[Mode] Vim mode confirmed, switching listeners');
        for (const d of activeDisposables) d.dispose();
        activeDisposables = registerVimListeners();
    }

    // 初始检测：isActive + 光标样式双向验证
    if (isVimVerified()) {
        isVimMode = true;
        logger.info('[Mode] Initial detection: Vim mode (verified)');
        activeDisposables = registerVimListeners();
    } else {
        logger.info('[Mode] Initial detection: Normal mode');
        activeDisposables = registerNormalListeners();

        // 兜底：2 秒后再次检测（Vim 可能延迟加载）
        setTimeout(() => {
            if (isVimMode) return;
            if (isVimVerified()) {
                switchToVimMode();
            }
        }, 2000);
    }

    logger.info(`[Mode] ${isVimMode ? 'Vim' : 'Normal'} mode listeners registered. Extension is ready.`);

    // 窗口焦点恢复时重新查询输入法状态
    const windowStateChange = vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
            const mode = imeManager.queryCurrentMode();
            if (mode && mode !== currentIMEMode) {
                logger.info(`[Focus] IME state changed externally: ${currentIMEMode} → ${mode}`);
                updateStatusBar(mode);
            } else {
                logger.debug(`[Focus] Window focused, IME unchanged: ${currentIMEMode}`);
            }
        }
    });
    context.subscriptions.push(windowStateChange);

    } catch (e: any) {
        const msg = e?.message || String(e);
        if (logger) {
            logger.error(`[FATAL] ${msg}`);
        } else {
            // logger 尚未初始化，直接写入 outputChannel
            outputChannel?.appendLine(`[FATAL] ${msg}`);
        }
    }
}

export function deactivate() {
    logger?.info('Extension auto-ime deactivated');
    if (analyzeDebounceTimer) {
        clearTimeout(analyzeDebounceTimer);
    }
    if (modeDetectionTimer) {
        clearInterval(modeDetectionTimer);
    }
    for (const d of activeDisposables) d.dispose();
    activeDisposables = [];
    if (imeStateManager) {
        imeStateManager.stopListening();
    }
    if (astAnalyzer) {
        astAnalyzer.dispose();
    }
}

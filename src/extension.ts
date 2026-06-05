/**
 * Auto IME — VSCode Extension Entry Point
 *
 * Thin orchestration layer:
 * 1. Create platform adapter (auto-detect Linux/Windows)
 * 2. Create AST analyzer
 * 3. Create state tracker
 * 4. Create controller
 * 5. Detect Vim mode → register appropriate mode listener
 * 6. Wire up status bar, commands, window focus
 */

import * as vscode from 'vscode';
import { ASTAnalyzer } from './ASTAnalyzer';
import { createLogger, LogSink } from './logger';
import { IMEController } from './core/controller';
import { IMEStateTracker } from './core/state-tracker';
import { IPlatformAdapter } from './core/types';
import { createPlatformAdapter } from './platforms';
import { NormalModeListener } from './modes/normal';
import { VimModeListener } from './modes/vim';

let outputChannel: vscode.OutputChannel;
let logger: LogSink | null = null;
let controller: IMEController | null = null;
let stateTracker: IMEStateTracker | null = null;
let activeAdapter: IPlatformAdapter | null = null;
let activeDisposables: vscode.Disposable[] = [];
let isVimMode = false;

// Session-level flag: only show English keyboard warning once
let englishKeyboardWarningShown = false;

/**
 * Verify Vim is active AND cursor is Block (bidirectional check)
 */
function isVimVerified(): boolean {
    const vimActive = !!vscode.extensions.getExtension('vscodevim.vim')?.isActive;
    const editor = vscode.window.activeTextEditor;
    const cursorIsBlock = editor?.options.cursorStyle === vscode.TextEditorCursorStyle.Block;
    return vimActive && !!cursorIsBlock;
}

/**
 * Switch to Vim mode listeners
 */
function switchToVimMode(ctx: vscode.ExtensionContext, controller: IMEController, logger: LogSink): void {
    isVimMode = true;
    controller.setVimMode(true);
    controller.setInsertModeCheck((editor) =>
        editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line
    );
    logger.info('[Mode] Vim mode confirmed, switching listeners');
    for (const d of activeDisposables) d.dispose();

    const vimListener = new VimModeListener(logger);
    activeDisposables = vimListener.register({
        analyzeAndSwitch: (editor) => controller.analyzeAndSwitch(editor),
        forceEnglish: () => controller.forceEnglish(),
        toggleIME: () => controller.toggleIME(),
        updateStatusBar: (mode) => controller.updateStatusBar(mode),
        logger,
    });
    ctx.subscriptions.push(...activeDisposables);
}

export async function activate(context: vscode.ExtensionContext) {
    try {
    // ========== Output Channel ==========
    outputChannel = vscode.window.createOutputChannel("Auto IME");
    context.subscriptions.push(outputChannel);

    // ========== Logger ==========
    const logDir = context.globalStorageUri.fsPath;
    const logFilePath = require('path').join(logDir, 'auto-ime.log');
    try { require('fs').mkdirSync(logDir, { recursive: true }); } catch {}
    try { require('fs').writeFileSync(logFilePath, '', 'utf-8'); } catch {}
    logger = createLogger('Extension', outputChannel, logFilePath);
    logger.info('Extension auto-ime is now active!');

    // ========== Platform Adapter ==========
    const adapter = createPlatformAdapter(logger);
    activeAdapter = adapter;

    // Windows: check English keyboard
    if (process.platform === 'win32' && !englishKeyboardWarningShown && !adapter.isReady()) {
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

    // ========== State Tracker ==========
    stateTracker = new IMEStateTracker(adapter, logger);
    stateTracker.setOnChangeCallback((newIME: string) => {
        const isEnglish = newIME === 'en';
        controller?.updateStatusBar(isEnglish ? 'en' : 'zh');
        logger.info(`[StatusBar] Manual switch sync: ${newIME} → ${isEnglish ? 'EN' : 'ZH'}`);
    });
    await stateTracker.startListening(
        process.platform === 'win32'
            ? (vscode.workspace.getConfiguration('auto-ime.windows').get<number>('pollingInterval') || 150)
            : undefined
    );

    // ========== Status Bar (right side) ==========
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'auto-ime.toggleIME';
    statusBarItem.show(); // Must explicitly show
    context.subscriptions.push(statusBarItem);

    // ========== AST Analyzer ==========
    const astLogger = createLogger('ASTAnalyzer', outputChannel, logFilePath);
    const analyzer = new ASTAnalyzer(context, outputChannel, astLogger);
    await analyzer.init();
    logger.info('AST Analyzer initialized.');

    // ========== Controller ==========
    controller = new IMEController(adapter, analyzer, stateTracker, statusBarItem, logger);

    // Initial state: switch to English keyboard and update status bar
    adapter.switchToEnglish();
    controller.updateStatusBar('en');
    stateTracker.notifyAutoSwitch('en'); // Sync state tracker to prevent false manual switch detection

    // Register toggle command
    const toggleCommand = vscode.commands.registerCommand('auto-ime.toggleIME', () => {
        controller?.toggleIME();
    });
    context.subscriptions.push(toggleCommand);

    // ========== Mode Detection ==========
    if (isVimVerified()) {
        isVimMode = true;
        logger.info('[Mode] Initial detection: Vim mode (verified)');
        switchToVimMode(context, controller, logger);
    } else {
        logger.info('[Mode] Initial detection: Normal mode');
        const normalListener = new NormalModeListener();
        activeDisposables = normalListener.register({
            analyzeAndSwitch: (editor) => controller!.analyzeAndSwitch(editor),
            forceEnglish: () => controller!.forceEnglish(),
            toggleIME: () => controller!.toggleIME(),
            updateStatusBar: (mode) => controller!.updateStatusBar(mode),
            logger,
        });
        context.subscriptions.push(...activeDisposables);

        // Retry Vim detection after 2s (Vim may load late)
        setTimeout(() => {
            if (isVimMode) return;
            if (isVimVerified()) {
                switchToVimMode(context, controller!, logger!);
            }
        }, 2000);
    }

    logger.info(`[Mode] ${isVimMode ? 'Vim' : 'Normal'} mode listeners registered. Extension is ready.`);

    // ========== Window Focus Sync ==========
    const windowStateChange = vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
            stateTracker?.syncState();
            const mode = controller?.queryCurrentMode();
            if (mode && controller && mode !== controller.getCurrentMode()) {
                logger.info(`[Focus] IME state changed externally: ${controller.getCurrentMode()} → ${mode}`);
                controller.updateStatusBar(mode);
            } else {
                logger.debug(`[Focus] Window focused, IME unchanged: ${controller?.getCurrentMode()}`);
            }
        }
    });
    context.subscriptions.push(windowStateChange);

    } catch (e: any) {
        const msg = e?.message || String(e);
        if (logger) {
            logger.error(`[FATAL] ${msg}`);
        } else {
            outputChannel?.appendLine(`[FATAL] ${msg}`);
        }
    }
}

export function deactivate() {
    logger?.info('Extension auto-ime deactivated');
    for (const d of activeDisposables) d.dispose();
    activeDisposables = [];
    stateTracker?.stopListening();
    activeAdapter?.dispose?.();
    activeAdapter = null;
}

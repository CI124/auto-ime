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
 *
 * State ownership: everything produced by one activation lives in a single
 * `ActivationSession`. VS Code disposes `context.subscriptions` on deactivate, and
 * the module keeps exactly one reference (the active session) so `deactivate()` can
 * still reach it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ASTAnalyzer } from './analysis/ASTAnalyzer';
import { createLogger, LogSink } from './infra/logger';
import { IMEController } from './core/controller';
import { IMEStateTracker } from './core/state-tracker';
import { IModeListener, IPlatformAdapter } from './core/types';
import { createPlatformAdapter } from './platforms';
import { NormalModeListener } from './modes/normal';
import { VimModeListener } from './modes/vim';

/** VSCodeVim may activate later than us; re-check after this delay */
const VIM_REDETECT_DELAY_MS = 2000;

/** 唯一模块级状态：当前激活会话（deactivate 需要够到它） */
let session: ActivationSession | null = null;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

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
 * One activation of the extension: all collaborators and per-session flags.
 */
class ActivationSession {
    readonly logger: LogSink;
    private readonly adapter: IPlatformAdapter;
    private readonly tracker: IMEStateTracker;
    private readonly controller: IMEController;
    private activeDisposables: vscode.Disposable[] = [];
    private vimModeConfirmed = false;
    // Session-level flag: only show English keyboard warning once
    private englishKeyboardWarningShown = false;

    private constructor(
        logger: LogSink,
        adapter: IPlatformAdapter,
        tracker: IMEStateTracker,
        controller: IMEController,
    ) {
        this.logger = logger;
        this.adapter = adapter;
        this.tracker = tracker;
        this.controller = controller;
    }

    /**
     * Build the whole object graph. Anything that throws is reported by `activate()`
     * as a single FATAL line; a partially built session disposes itself first so a
     * started poll timer can never outlive a failed activation.
     */
    static async create(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<ActivationSession> {
        // ========== Logger ==========
        const logFilePath = ActivationSession.prepareLogFile(context, outputChannel);
        const logger = createLogger('Extension', outputChannel, logFilePath);
        logger.info('Extension auto-ime is now active!');

        // ========== Platform Adapter ==========
        const adapter = createPlatformAdapter(logger);

        // ========== State Tracker ==========
        const tracker = new IMEStateTracker(adapter, logger);
        const statusBarItem = ActivationSession.createStatusBar(context);

        // ========== AST Analyzer ==========
        const astLogger = createLogger('ASTAnalyzer', outputChannel, logFilePath);
        const analyzer = new ASTAnalyzer(context, outputChannel, astLogger);
        context.subscriptions.push(analyzer); // Releases WASM Tree/Query/Language/Parser
        await analyzer.init();
        logger.info('AST Analyzer initialized.');

        const controller = new IMEController(adapter, analyzer, tracker, statusBarItem, logger);
        const created = new ActivationSession(logger, adapter, tracker, controller);

        try {
            tracker.setOnChangeCallback((newIME: string) => created.onExternalSwitch(newIME));
            // 外部切换检测由各平台适配器负责（Linux 自适应轮询 / Windows 双键盘 Language ID 轮询），
            // 本扩展不叠加第二层轮询
            await tracker.startListening();
            await created.warnIfEnglishKeyboardMissing(outputChannel);
            ActivationSession.registerToggleCommand(context, controller);
            created.initInitialMode();
            created.registerModeListeners(context);
            created.registerFocusSync(context);
        } catch (error) {
            created.dispose();
            throw error;
        }
        return created;
    }

    dispose(): void {
        this.logger.info('Extension auto-ime deactivated');
        for (const d of this.activeDisposables) d.dispose();
        this.activeDisposables = [];
        this.controller.dispose();
        this.tracker.stopListening();
        this.adapter.dispose?.();
    }

    // ========== Wiring steps ==========

    /** The file sink is best-effort: a broken storage dir must not stop the extension. */
    private static prepareLogFile(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): string {
        const logDir = context.globalStorageUri.fsPath;
        const logFilePath = path.join(logDir, 'auto-ime.log');
        try {
            fs.mkdirSync(logDir, { recursive: true });
            fs.writeFileSync(logFilePath, '', 'utf-8');
        } catch (error) {
            outputChannel.appendLine(`[WARN] [Bootstrap] file logging disabled: ${errorMessage(error)}`);
        }
        return logFilePath;
    }

    private static createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'auto-ime.toggleIME';
        statusBarItem.show(); // Must explicitly show
        context.subscriptions.push(statusBarItem);
        return statusBarItem;
    }

    private static registerToggleCommand(context: vscode.ExtensionContext, controller: IMEController): void {
        context.subscriptions.push(
            vscode.commands.registerCommand('auto-ime.toggleIME', () => controller.toggleIME())
        );
    }

    private initInitialMode(): void {
        // Initial state: switch to English keyboard and update status bar
        this.adapter.switchToEnglish();
        this.controller.updateStatusBar('en');
        this.tracker.notifyAutoSwitch('en'); // Sync state tracker to prevent false manual switch detection
    }

    /** Windows only: a missing English layout makes every strategy unusable, so guide the user. */
    private async warnIfEnglishKeyboardMissing(outputChannel: vscode.OutputChannel): Promise<void> {
        if (process.platform !== 'win32' || this.englishKeyboardWarningShown || this.adapter.isReady()) return;

        this.englishKeyboardWarningShown = true;
        this.logger.warn('English keyboard layout not found, showing user guidance');
        vscode.window.showInformationMessage(
            'Auto IME 需要系统安装英语(美国)键盘布局才能正常工作。请在 Windows 设置 > 时间和语言 > 语言 中添加英语(美国)。',
            '打开设置'
        ).then((selection) => {
            if (selection === '打开设置') {
                void vscode.env.openExternal(vscode.Uri.parse('ms-settings:regionlanguage'));
            }
        }, () => {
            outputChannel.appendLine('[WARN] Failed to show the English-keyboard guidance');
        });
    }

    private onExternalSwitch(newIME: string): void {
        const isEnglish = newIME === 'en';
        this.controller.updateStatusBar(isEnglish ? 'en' : 'zh');
        this.logger.info(`[StatusBar] Manual switch sync: ${newIME} → ${isEnglish ? 'EN' : 'ZH'}`);
    }

    private registerModeListeners(context: vscode.ExtensionContext): void {
        const logger = this.logger;
        if (isVimVerified()) {
            logger.info('[Mode] Initial detection: Vim mode (verified)');
            this.switchToVimMode(context);
        } else {
            logger.info('[Mode] Initial detection: Normal mode');
            this.registerModeListener(context, new NormalModeListener());
            this.scheduleVimRedetect(context);
        }
        logger.info(`[Mode] ${this.vimModeConfirmed ? 'Vim' : 'Normal'} mode listeners registered. Extension is ready.`);
    }

    /** Vim may load later than us; retry once (cancelled for free via subscriptions). */
    private scheduleVimRedetect(context: vscode.ExtensionContext): void {
        const retryTimer = setTimeout(() => {
            if (!this.vimModeConfirmed && isVimVerified()) {
                this.switchToVimMode(context);
            }
        }, VIM_REDETECT_DELAY_MS);
        context.subscriptions.push({ dispose: () => clearTimeout(retryTimer) });
    }

    private registerFocusSync(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.window.onDidChangeWindowState((e) => {
                if (!e.focused) return;

                this.tracker.syncState();
                const mode = this.controller.queryCurrentMode();
                if (mode && mode !== this.controller.getCurrentMode()) {
                    this.logger.info(`[Focus] IME state changed externally: ${this.controller.getCurrentMode()} → ${mode}`);
                    this.controller.updateStatusBar(mode);
                } else {
                    this.logger.debug(`[Focus] Window focused, IME unchanged: ${this.controller.getCurrentMode()}`);
                }
            })
        );
    }

    /**
     * Switch to Vim mode listeners
     */
    private switchToVimMode(context: vscode.ExtensionContext): void {
        this.vimModeConfirmed = true;
        this.controller.setVimMode(true);
        this.controller.setInsertModeCheck((editor) =>
            editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line
        );
        this.logger.info('[Mode] Vim mode confirmed, switching listeners');
        this.registerModeListener(context, new VimModeListener(this.logger));

        // Sync IME state with current cursor position after Vim mode activation
        // (Vim Normal mode skips auto-switch, but we should sync once on detection)
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.controller.analyzeAndSwitch(editor);
        }
    }

    /**
     * Replace the currently registered mode listener with a new one
     */
    private registerModeListener(context: vscode.ExtensionContext, listener: IModeListener): void {
        for (const d of this.activeDisposables) d.dispose();

        this.activeDisposables = listener.register({
            analyzeAndSwitch: (editor) => this.controller.analyzeAndSwitch(editor),
            forceEnglish: () => this.controller.forceEnglish(),
            toggleIME: () => this.controller.toggleIME(),
            updateStatusBar: (mode) => this.controller.updateStatusBar(mode),
            logger: this.logger,
        });
        context.subscriptions.push(...this.activeDisposables);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Auto IME');
    context.subscriptions.push(outputChannel);

    try {
        session = await ActivationSession.create(context, outputChannel);
    } catch (error) {
        const msg = errorMessage(error);
        if (session) {
            session.logger.error(`[FATAL] ${msg}`);
        } else {
            outputChannel.appendLine(`[FATAL] ${msg}`);
        }
    }
}

export function deactivate() {
    session?.dispose();
    session = null;
}

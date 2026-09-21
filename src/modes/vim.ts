/**
 * Vim Mode Listener
 * For editors with VSCodeVim extension
 * Handles ESC → force English, Insert/Normal mode detection
 */

import * as vscode from 'vscode';
import { IModeListener, ModeContext } from '../core/types';
import { LogSink } from '../infra/logger';

export class VimModeListener implements IModeListener {
    readonly name = 'vim';
    private lastCursorStyle: vscode.TextEditorCursorStyle | undefined;
    private modeDetectionTimer: NodeJS.Timeout | null = null;
    private logger: LogSink;

    constructor(logger: LogSink) {
        this.logger = logger;
    }

    register(ctx: ModeContext): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        // 保证无论模式切换还是 deactivate，20ms 的 cursorStyle 探测定时器都能被清理
        // （扩展只 dispose() 本数组，从不调用 listener.dispose()，故必须在此登记）
        disposables.push({ dispose: () => this.stopModeDetection() });

        // ESC hijack: force English + forward to Vim
        const escapeCommand = vscode.commands.registerCommand('auto-ime.escape', () => {
            ctx.forceEnglish();
            vscode.commands.executeCommand('extension.vim_escape');
        });
        disposables.push(escapeCommand);

        // Initialize cursor style
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            this.lastCursorStyle = activeEditor.options.cursorStyle;
            if (this.lastCursorStyle !== vscode.TextEditorCursorStyle.Line) {
                this.startModeDetection(ctx);
            }
        }

        // Editor change: track cursor style
        const editorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                this.lastCursorStyle = editor.options.cursorStyle;
                if (this.lastCursorStyle !== vscode.TextEditorCursorStyle.Line) {
                    this.startModeDetection(ctx);
                } else {
                    this.stopModeDetection();
                }
            }
        });
        disposables.push(editorChange);

        // Selection change: detect Insert → Normal, analyze in Insert mode
        const selectionChange = vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!e.textEditor.document) return;

            const currentCursorStyle = e.textEditor.options.cursorStyle;

            // Detect Insert → Normal: force English
            if (this.lastCursorStyle === vscode.TextEditorCursorStyle.Line &&
                currentCursorStyle === vscode.TextEditorCursorStyle.Block) {
                this.onInsertToNormal(ctx);
            }
            this.lastCursorStyle = currentCursorStyle;

            // Only analyze in Insert mode
            if (!this.isInInsertMode(e.textEditor)) return;
            this.stopModeDetection();
            ctx.analyzeAndSwitch(e.textEditor);
        });
        disposables.push(selectionChange);

        // Document change: only in Insert mode
        const documentChange = vscode.workspace.onDidChangeTextDocument((e) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== e.document) return;
            if (!this.isInInsertMode(editor)) return;
            ctx.analyzeAndSwitch(editor);
        });
        disposables.push(documentChange);

        // Cursor style change: detect Normal → Insert
        const optionsChange = vscode.window.onDidChangeTextEditorOptions((e) => {
            const currentCursor = e.textEditor.options.cursorStyle;
            if (this.lastCursorStyle === vscode.TextEditorCursorStyle.Block &&
                currentCursor === vscode.TextEditorCursorStyle.Line) {
                // Normal → Insert
                this.stopModeDetection();
                this.lastCursorStyle = currentCursor;
                ctx.analyzeAndSwitch(e.textEditor);
            } else if (this.lastCursorStyle === vscode.TextEditorCursorStyle.Line &&
                       currentCursor === vscode.TextEditorCursorStyle.Block) {
                // Insert → Normal
                this.onInsertToNormal(ctx);
                this.lastCursorStyle = currentCursor;
            }
        });
        disposables.push(optionsChange);

        return disposables;
    }

    dispose(): void {
        this.stopModeDetection();
    }

    // ========== Private ==========

    isInInsertMode(editor: vscode.TextEditor): boolean {
        return editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line;
    }

    /**
     * Insert → Normal 转换的唯一入口：强制切英文并启动模式探测。
     * selectionChange 与 optionsChange 两条路径都用它，避免重复的 forceEnglish + startModeDetection。
     */
    private onInsertToNormal(ctx: ModeContext): void {
        ctx.forceEnglish();
        this.startModeDetection(ctx);
    }

    private startModeDetection(ctx: ModeContext): void {
        if (this.modeDetectionTimer) return;
        this.checkModeChange(ctx);
        // 主检测依赖 onDidChangeTextEditorOptions 事件；此处仅作兵底轮询（进入 Normal
        // 后监视游标样式是否回到 Insert），40ms 已足够及时且比旧 20ms 省一半开销
        this.modeDetectionTimer = setInterval(() => this.checkModeChange(ctx), 40);
    }

    private stopModeDetection(): void {
        if (this.modeDetectionTimer) {
            clearInterval(this.modeDetectionTimer);
            this.modeDetectionTimer = null;
        }
    }

    private checkModeChange(ctx: ModeContext): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        if (editor.options.cursorStyle === vscode.TextEditorCursorStyle.Line) {
            this.stopModeDetection();
            this.lastCursorStyle = editor.options.cursorStyle;
            ctx.analyzeAndSwitch(editor);
        }
    }
}

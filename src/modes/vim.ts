/**
 * Vim Mode Listener
 * For editors with VSCodeVim extension
 * Handles ESC → force English, Insert/Normal mode detection
 */

import * as vscode from 'vscode';
import { IModeListener, ModeContext } from '../core/types';
import { LogSink } from '../logger';

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
                ctx.forceEnglish();
                this.startModeDetection(ctx);
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
                ctx.forceEnglish();
                this.startModeDetection(ctx);
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

    private startModeDetection(ctx: ModeContext): void {
        if (this.modeDetectionTimer) return;
        this.checkModeChange(ctx);
        this.modeDetectionTimer = setInterval(() => this.checkModeChange(ctx), 20);
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

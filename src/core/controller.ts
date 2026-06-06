/**
 * IME Controller — core switching orchestration
 * Platform-agnostic: delegates to IPlatformAdapter for actual switching
 *
 * Responsibilities:
 * - Analyze cursor context (comment/string/code)
 * - Decide whether to switch (方案A: only comments)
 * - Execute switch via adapter
 * - Manage status bar
 *
 * Does NOT care about:
 * - Where events come from (selection/document/ESC)
 * - How switching works (Layout/TSF/Fcitx5)
 * - What mode the editor is in (Normal/Vim)
 */

import * as vscode from 'vscode';
import { ASTAnalyzer } from '../ASTAnalyzer';
import { IPlatformAdapter, SwitchResult } from './types';
import { IMEStateTracker } from './state-tracker';
import { LogSink } from '../logger';

export class IMEController {
    private adapter: IPlatformAdapter;
    private analyzer: ASTAnalyzer;
    private stateTracker: IMEStateTracker;
    private logger: LogSink;
    private currentMode: 'en' | 'zh' = 'en';
    private statusBarItem: vscode.StatusBarItem;

    constructor(
        adapter: IPlatformAdapter,
        analyzer: ASTAnalyzer,
        stateTracker: IMEStateTracker,
        statusBarItem: vscode.StatusBarItem,
        logger: LogSink,
    ) {
        this.adapter = adapter;
        this.analyzer = analyzer;
        this.stateTracker = stateTracker;
        this.statusBarItem = statusBarItem;
        this.logger = logger;
    }

    /**
     * Get current IME mode
     */
    getCurrentMode(): 'en' | 'zh' {
        return this.currentMode;
    }

    /**
     * Update status bar display
     */
    updateStatusBar(mode: 'en' | 'zh'): void {
        this.currentMode = mode;
        if (mode === 'zh') {
            this.statusBarItem.text = '$(keyboard) 中';
            this.statusBarItem.tooltip = '当前: 中文输入法 (点击切换到英文)';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = '$(keyboard) EN';
            this.statusBarItem.tooltip = '当前: 英文输入法 (点击切换到中文)';
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    /**
     * Core analysis + switch flow
     * Called by mode listeners when cursor context may have changed
     */
    async analyzeAndSwitch(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;

        // Skip non-code documents (output panels, diff views, etc.)
        const scheme = document.uri.scheme;
        if (scheme !== 'file' && scheme !== 'untitled') {
            return;
        }

        const position = editor.selections[0].active;
        // Guard against stale positions after document changes
        if (position.line >= document.lineCount) return;
        const cursor = `L${position.line + 1}:${position.character}`;
        const lang = document.languageId;
        const vimMode = this.isVimMode() ? (this.isInInsertMode(editor) ? 'I' : 'N') : '-';

        // Manual override: resume auto analysis when cursor moves to different line
        if (this.stateTracker.isManualOverride()) {
            if (this.stateTracker.isDifferentPosition(position.line)) {
                this.logger.info(`[${cursor}] ${lang} vim=${vimMode} → manual override resume`);
                this.stateTracker.resetManualOverride();
            } else {
                return;
            }
        }

        this.stateTracker.updatePosition(position.line, position.character);

        // Fast path: text-based comment detection (synchronous, no AST cost)
        const fastResult = this.analyzer.isCursorInCommentFast(document, position, lang);
        if (fastResult === true) {
            if (this.currentMode !== 'zh') {
                this.logger.info(`[${cursor}] ${lang} vim=${vimMode} → comment (fast) → switch to ZH`);
                this.switchTo('zh');
            }
            return;
        }

        // Full AST analysis
        const astResult = await this.analyzer.isCursorInCommentOrString(document, position);

        if (astResult.match) {
            // 方案 A: only switch in comments, not strings
            if (astResult.type === 'string') {
                return;
            }
            // Comment → switch to Chinese
            if (this.currentMode !== 'zh') {
                this.logger.info(`[${cursor}] ${lang} vim=${vimMode} → comment → switch to ZH`);
                this.switchTo('zh');
            }
        } else {
            // Code → switch to English
            if (this.currentMode !== 'en') {
                this.logger.info(`[${cursor}] ${lang} vim=${vimMode} → code → switch to EN`);
                this.switchTo('en');
            }
        }
    }

    /**
     * Force switch to English (ESC in Vim mode)
     * Always executes, doesn't check currentMode
     */
    forceEnglish(): void {
        const result = this.adapter.switchToEnglish();
        this.updateStatusBar('en');
        this.stateTracker.notifyAutoSwitch('en'); // Sync state tracker immediately
        this.logger.info(`[ESC] Forced switch to English (method: ${result.method})`);
        this.stateTracker.resetManualOverride();
    }

    /**
     * Toggle IME (user manual trigger via status bar)
     */
    toggleIME(): void {
        if (this.currentMode === 'zh') {
            this.adapter.switchToEnglish();
            this.updateStatusBar('en');
            this.stateTracker.notifyAutoSwitch('en');
            this.logger.info('[StatusBar] User toggled to English');
        } else {
            this.adapter.switchToChinese();
            this.updateStatusBar('zh');
            this.stateTracker.notifyAutoSwitch('zh');
            this.logger.info('[StatusBar] User toggled to Chinese');
        }
        this.stateTracker.markManualSwitch();
    }

    /**
     * Query current mode from adapter (for external sync)
     */
    queryCurrentMode(): 'zh' | 'en' {
        return this.adapter.queryMode();
    }

    // ========== Private ==========

    private switchTo(mode: 'zh' | 'en'): void {
        this.updateStatusBar(mode); // Optimistic update
        this.stateTracker.notifyAutoSwitch(mode); // Update state tracker immediately

        let result: SwitchResult;
        if (mode === 'zh') {
            result = this.adapter.switchToChinese();
        } else {
            result = this.adapter.switchToEnglish();
        }

        if (result.method !== 'skip') {
            this.logger.debug(`[Controller] switch to ${mode}: ${result.method} (${result.elapsedMs ?? 0}ms)`);
        }
    }

    // Vim detection helpers — will be set by mode listener registration
    private _isVimMode = false;
    private _isInInsertMode: (editor: vscode.TextEditor) => boolean = () => true;

    setVimMode(isVim: boolean): void {
        this._isVimMode = isVim;
    }

    setInsertModeCheck(fn: (editor: vscode.TextEditor) => boolean): void {
        this._isInInsertMode = fn;
    }

    private isVimMode(): boolean {
        return this._isVimMode;
    }

    private isInInsertMode(editor: vscode.TextEditor): boolean {
        return this._isInInsertMode(editor);
    }
}

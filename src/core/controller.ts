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
import { IAnalyzer, IPlatformAdapter, SwitchResult } from './types';
import { IMEStateTracker } from './state-tracker';
import { LogSink } from '../infra/logger';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class IMEController {
    private adapter: IPlatformAdapter;
    private analyzer: IAnalyzer;
    private stateTracker: IMEStateTracker;
    private logger: LogSink;
    private currentMode: 'en' | 'zh' = 'en';
    private statusBarItem: vscode.StatusBarItem;
    // 事件级防抖：合并同一次操作触发的多次事件（见 analyzeAndSwitch）
    private analysisTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingEditor: vscode.TextEditor | null = null;

    constructor(
        adapter: IPlatformAdapter,
        analyzer: IAnalyzer,
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
     * 事件级防抖：同一次用户操作会先后触发 selection / document 事件，这里按文件
     * 大小做 10/30/60ms 尾随防抖，只真正分析最后一批，避免重复的 AST 解析。
     * （generation 取消机制仍会丢弃过期解析结果，二者互补。）
     * 由模式监听器在游标上下文可能变化时调用。
     *
     * 本方法【不得抛出、不得产生未处理 rejection】：调用方（normal/vim 监听器与定时器）
     * 都是 fire-and-forget，一旦逸出会静默丢掉这一轮判定并在扩展宿主留下 unhandledRejection。
     */
    async analyzeAndSwitch(editor: vscode.TextEditor): Promise<void> {
        try {
            const scheme = editor.document.uri.scheme;
            if (scheme !== 'file' && scheme !== 'untitled') return; // 非代码文档无需排队

            this.pendingEditor = editor;
            if (this.analysisTimer === null) {
                const lines = editor.document.lineCount;
                const delay = lines < 500 ? 10 : lines < 2000 ? 30 : 60;
                this.analysisTimer = setTimeout(() => {
                    this.analysisTimer = null;
                    const ed = this.pendingEditor;
                    this.pendingEditor = null;
                    if (ed) this.runAnalysis(ed);
                }, delay);
            }
        } catch (error) {
            this.logger.error(`[Analyze] 调度失败: ${errorMessage(error)}`);
        }
    }

    /** 防抖定时器里唯一的调用点：把 doAnalyze 的 rejection 就地消化 */
    private runAnalysis(editor: vscode.TextEditor): void {
        this.doAnalyze(editor).catch((error) => {
            this.logger.error(`[Analyze] 分析失败，本轮不切换: ${errorMessage(error)}`);
        });
    }

    /** 真正的分析 + 切换（被 analyzeAndSwitch 防抖后调用） */
    private async doAnalyze(editor: vscode.TextEditor): Promise<void> {
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

        // 无判定能力的语言一律不干预（方案 A 的“不干预优于误伤”）：
        // AST 对未登记语言只能返回 match:false，而“不知道”不等于“确认是代码”。
        // 以前 markdown/plaintext 会因此被当成代码抢切回英文，用户连笔记都写不了。
        if (!this.analyzer.supports(lang)) {
            this.logger.debug(`[${cursor}] ${lang} → 无判定能力，不干预`);
            return;
        }

        const vimMode = this.isVimMode() ? (this.isInInsertMode(editor) ? 'I' : 'N') : '-';

        // 手动覆盖：游标换行后恢复自动分析，同行则保持用户的选择不动
        if (!this.passManualOverride(position, lang, vimMode, cursor)) {
            return;
        }

        this.stateTracker.updatePosition(position.line);

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
     * manualOverride 闸门：返回 false 表示本轮不得继续分析（用户手动选择优先）。
     * 从 doAnalyze 抽出来是为了让两者各自守在函数粒度软档内。
     */
    private passManualOverride(
        position: vscode.Position,
        lang: string,
        vimMode: string,
        cursor: string,
    ): boolean {
        if (!this.stateTracker.isManualOverride()) return true;
        if (!this.stateTracker.isDifferentPosition(position.line)) return false;

        this.logger.info(`[${cursor}] ${lang} vim=${vimMode} → manual override resume`);
        this.stateTracker.resetManualOverride();
        return true;
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
        const target: 'zh' | 'en' = this.currentMode === 'zh' ? 'en' : 'zh';
        this.switchTo(target);
        this.logger.info(`[StatusBar] User toggled to ${target === 'zh' ? 'Chinese' : 'English'}`);
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
            if (result.success) {
                this.logger.debug(`[Controller] switch to ${mode}: ${result.method} (${result.elapsedMs ?? 0}ms)`);
            } else {
                // 消费 success：适配器显式报告失败时留下告警，便于定位切换无效
                this.logger.warn(`[Controller] switch to ${mode} FAILED (method=${result.method})`);
            }
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

    /** 释放：清理待执行的防抖定时器（扩展 deactivate 时调用） */
    dispose(): void {
        if (this.analysisTimer) {
            clearTimeout(this.analysisTimer);
            this.analysisTimer = null;
        }
        this.pendingEditor = null;
    }
}

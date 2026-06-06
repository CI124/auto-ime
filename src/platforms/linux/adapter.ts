/**
 * Linux Platform Adapter
 * Auto-detects and delegates to Fcitx5 or IBus
 *
 * Business logic:
 * - Fcitx5: reads ~/.config/fcitx5/profile to discover actual input method names
 * - IBus: exact match against configured engine name
 * - PATH: ensures /usr/local/bin, /usr/bin, /bin are available
 * - Detection: uses bash -c "command -v ..." for reliable detection
 *
 * State tracking: adaptive polling (not D-Bus signals)
 * - Fcitx5 signals are NOT emitted for remote switching (fcitx5-remote)
 * - Uses async polling with adaptive intervals for reliability
 * - Active mode: 100ms polling, Idle mode: 500ms polling
 *
 * Fcitx4 removed: deprecated project, users should migrate to Fcitx5
 */

import { exec, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { IPlatformAdapter, SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';

// ========== PATH Helper ==========

function buildEnvPath(): string {
    const existing = process.env.PATH || '';
    const sep = ':';
    const parts = existing.split(sep).filter(Boolean);
    const extras = ['/usr/local/bin', '/usr/bin', '/bin'];
    for (const extra of extras) {
        if (!parts.includes(extra)) {
            parts.push(extra);
        }
    }
    return parts.join(sep);
}

// ========== Bash Helper ==========

function runBash(script: string, args: string[], envPath: string, timeout: number): string {
    return execFileSync('bash', ['-c', script, 'bash_script.sh', ...args], {
        encoding: 'utf-8',
        timeout,
        env: { ...process.env, PATH: envPath }
    }).trim();
}

function runBashAsync(script: string, envPath: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(`bash -c '${script}'`, {
            encoding: 'utf-8',
            timeout,
            env: { ...process.env, PATH: envPath }
        }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

function tryExecBash(script: string, envPath: string, timeout: number): boolean {
    try {
        execFileSync('bash', ['-c', script, 'bash_script.sh'], {
            encoding: 'utf-8',
            timeout,
            env: { ...process.env, PATH: envPath }
        });
        return true;
    } catch {
        return false;
    }
}

// ========== Fcitx5 Profile Reader ==========

function readFcitx5Profile(logger: LogSink): { english: string; chinese: string } {
    const defaultEnglish = 'keyboard-us';
    const defaultChinese = 'pinyin';
    const profilePath = path.join(os.homedir(), '.config', 'fcitx5', 'profile');

    try {
        if (!fs.existsSync(profilePath)) {
            logger.info(`[Linux] fcitx5 profile not found: ${profilePath}`);
            return { english: defaultEnglish, chinese: defaultChinese };
        }

        const content = fs.readFileSync(profilePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const allMethods: string[] = [];
        let inGroupItems = false;

        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;

            if (line.startsWith('[')) {
                inGroupItems = /^\[Groups\/0\/Items\/\d+\]$/.test(line);
                continue;
            }

            if (!inGroupItems) continue;

            if (line.startsWith('Name=') && !line.startsWith('Name=默认')) {
                allMethods.push(line.substring('Name='.length).trim());
            }
        }

        const englishCandidates = allMethods.filter(m => m.includes('keyboard'));
        const english = englishCandidates.includes('keyboard-us')
            ? 'keyboard-us'
            : (englishCandidates[0] || defaultEnglish);

        const chinesePriority = ['rime', 'pinyin', 'shuangpin'];
        const chineseCandidates = allMethods.filter(m => !m.includes('keyboard'));
        const chinese = chinesePriority.find(p => chineseCandidates.includes(p))
            || chineseCandidates[0]
            || defaultChinese;

        logger.info(`[Linux] fcitx5 profile loaded: english=${english}, chinese=${chinese}`);
        return { english, chinese };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Linux] Failed to read fcitx5 profile: ${message}`);
        return { english: defaultEnglish, chinese: defaultChinese };
    }
}

// ========== Adaptive Polling ==========

interface AdaptivePollConfig {
    activeInterval: number;   // 活动状态轮询间隔 (ms)
    idleInterval: number;     // 空闲状态轮询间隔 (ms)
    idleThreshold: number;    // 进入空闲状态的阈值 (ms)
}

const DEFAULT_POLL_CONFIG: AdaptivePollConfig = {
    activeInterval: 100,
    idleInterval: 500,
    idleThreshold: 5000
};

// ========== Linux Adapter ==========

export class LinuxAdapter implements IPlatformAdapter {
    readonly name = 'linux';
    private logger!: LogSink;
    private envPath!: string;
    private manager: LinuxIMEManager | null = null;
    private changeCallback: ((mode: 'zh' | 'en') => void) | null = null;
    
    // Adaptive polling state
    private pollTimer: NodeJS.Timeout | null = null;
    private lastActivityTime: number = Date.now();
    private lastPolledMode: 'zh' | 'en' = 'en';
    private pollConfig: AdaptivePollConfig = DEFAULT_POLL_CONFIG;

    init(logger: LogSink): void {
        this.logger = logger;
        this.envPath = buildEnvPath();
        logger.info(`[Linux] Using PATH: ${this.envPath}`);

        if (this.isFcitx5Available()) {
            this.manager = new Fcitx5Manager(logger, this.envPath);
            logger.info('[Linux] Using Fcitx5');
        } else if (this.isIBusAvailable()) {
            this.manager = new IBusManager(logger, this.envPath);
            logger.info('[Linux] Using IBus');
        } else {
            logger.warn('[Linux] No supported IME framework detected (Fcitx5/IBus)');
        }
    }

    isReady(): boolean {
        return this.manager !== null;
    }

    queryMode(): 'zh' | 'en' {
        if (!this.manager) return 'en';
        return this.manager.queryMode();
    }

    switchToEnglish(): SwitchResult {
        if (!this.manager) return { success: false, method: 'none' };
        const result = this.manager.switchToEnglish();
        // Update last activity time on switch
        this.lastActivityTime = Date.now();
        return result;
    }

    switchToChinese(): SwitchResult {
        if (!this.manager) return { success: false, method: 'none' };
        const result = this.manager.switchToChinese();
        // Update last activity time on switch
        this.lastActivityTime = Date.now();
        return result;
    }

    /**
     * Sync internal state with actual system state
     * Called on window focus restore
     */
    syncState(): void {
        if (this.manager && 'syncFromSystem' in this.manager) {
            (this.manager as any).syncFromSystem();
        }
    }

    /**
     * Start adaptive polling for external manual switches
     * 
     * Why polling instead of D-Bus signals?
     * - Fcitx5 does NOT emit InputContext signals for remote switching
     * - dbus-monitor showed only method calls (SetCurrentIM, Toggle), no signals
     * - Async polling with adaptive intervals is reliable and non-blocking
     * 
     * Returns false to indicate polling mode (not event-driven)
     */
    async startListening(callback: (mode: 'zh' | 'en') => void): Promise<boolean> {
        this.changeCallback = callback;
        this.lastPolledMode = this.queryMode();
        this.lastActivityTime = Date.now();
        
        this.logger.info(`[Linux] Starting adaptive polling (active=${this.pollConfig.activeInterval}ms, idle=${this.pollConfig.idleInterval}ms)`);
        this.startAdaptivePolling();
        
        return false; // Not using D-Bus signals
    }

    /**
     * Stop polling
     */
    stopListening(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
            this.logger.info('[Linux] Polling stopped');
        }
    }

    dispose(): void {
        this.stopListening();
    }

    // ========== Adaptive Polling Implementation ==========

    private startAdaptivePolling(): void {
        const poll = async () => {
            try {
                // Use async query to avoid blocking
                const newMode = await this.queryModeAsync();
                
                if (newMode !== this.lastPolledMode) {
                    const oldMode = this.lastPolledMode;
                    this.lastPolledMode = newMode;
                    this.lastActivityTime = Date.now(); // Keep high frequency on change
                    
                    this.logger.info(`[Linux] Polling detected change: ${oldMode} → ${newMode}`);
                    
                    if (this.changeCallback) {
                        this.changeCallback(newMode);
                    }
                }
            } catch (error) {
                // Ignore polling errors, will retry next interval
                this.logger.debug(`[Linux] Polling error: ${error}`);
            }
            
            // Schedule next poll with adaptive interval
            const nextInterval = this.getNextInterval();
            this.pollTimer = setTimeout(poll, nextInterval);
        };
        
        // Start first poll
        poll();
    }

    private getNextInterval(): number {
        const timeSinceActivity = Date.now() - this.lastActivityTime;
        return timeSinceActivity < this.pollConfig.idleThreshold
            ? this.pollConfig.activeInterval
            : this.pollConfig.idleInterval;
    }

    /**
     * Async mode query (non-blocking)
     */
    private async queryModeAsync(): Promise<'zh' | 'en'> {
        if (!this.manager) return 'en';
        
        if (this.manager instanceof Fcitx5Manager) {
            return await this.manager.queryModeAsync(this.envPath);
        } else if (this.manager instanceof IBusManager) {
            return await this.manager.queryModeAsync(this.envPath);
        }
        
        return this.manager.queryMode();
    }

    // ========== Detection ==========

    private isFcitx5Available(): boolean {
        return tryExecBash(
            'command -v fcitx5-remote >/dev/null 2>&1 && [ -f "$HOME/.config/fcitx5/profile" ]',
            this.envPath, 5000
        );
    }

    private isIBusAvailable(): boolean {
        return tryExecBash(
            'command -v ibus >/dev/null 2>&1',
            this.envPath, 5000
        );
    }
}

// ========== Internal IME Managers ==========

interface LinuxIMEManager {
    queryMode(): 'zh' | 'en';
    switchToEnglish(): SwitchResult;
    switchToChinese(): SwitchResult;
    syncFromSystem?(): void;
    queryFromSystem(): string;
}

// ========== Fcitx5 Manager ==========

const FCITX5_SWITCH_SCRIPT = `fcitx5-remote -s "$1"`;

class Fcitx5Manager implements LinuxIMEManager {
    private logger: LogSink;
    private envPath: string;
    private englishTarget: string;
    private chineseTarget: string;
    private currentTarget: string;

    constructor(logger: LogSink, envPath: string) {
        this.logger = logger;
        this.envPath = envPath;
        const targets = readFcitx5Profile(logger);
        this.englishTarget = targets.english;
        this.chineseTarget = targets.chinese;
        this.currentTarget = this.queryFromSystem();
        logger.info(`[Fcitx5] Initial state: ${this.currentTarget === this.englishTarget ? 'en' : 'zh'}`);
    }

    getEnglishTarget(): string { return this.englishTarget; }
    getChineseTarget(): string { return this.chineseTarget; }

    queryMode(): 'zh' | 'en' {
        return this.currentTarget === this.englishTarget ? 'en' : 'zh';
    }

    /**
     * Async mode query for polling (non-blocking)
     */
    async queryModeAsync(envPath: string): Promise<'zh' | 'en'> {
        try {
            const result = await runBashAsync('fcitx5-remote -n', envPath, 1000);
            const target = result || this.englishTarget;
            this.currentTarget = target;
            return target === this.englishTarget ? 'en' : 'zh';
        } catch {
            return this.queryMode(); // Fallback to sync
        }
    }

    switchToEnglish(): SwitchResult {
        if (this.currentTarget === this.englishTarget) {
            return { success: true, method: 'skip' };
        }
        this.currentTarget = this.englishTarget;
        this.runBash(FCITX5_SWITCH_SCRIPT, [this.englishTarget], `fcitx5-remote -s ${this.englishTarget}`);
        return { success: true, method: 'fcitx5' };
    }

    switchToChinese(): SwitchResult {
        if (this.currentTarget === this.chineseTarget) {
            return { success: true, method: 'skip' };
        }
        this.currentTarget = this.chineseTarget;
        this.runBash(FCITX5_SWITCH_SCRIPT, [this.chineseTarget], `fcitx5-remote -s ${this.chineseTarget}`);
        return { success: true, method: 'fcitx5' };
    }

    syncFromSystem(): void {
        const systemTarget = this.queryFromSystem();
        if (systemTarget !== this.currentTarget) {
            this.logger.info(`[Fcitx5] Sync: ${this.currentTarget} → ${systemTarget}`);
            this.currentTarget = systemTarget;
        }
    }

    queryFromSystem(): string {
        const result = this.runBash('fcitx5-remote -n', [], 'fcitx5-remote -n');
        return result || this.englishTarget;
    }

    private runBash(script: string, args: string[], label: string): string {
        try {
            return runBash(script, args, this.envPath, 1000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Fcitx5] ${label} failed: ${message}`);
            return '';
        }
    }
}

// ========== IBus Manager ==========

const IBUS_ENGINE_SCRIPT = `ibus engine "$1" &> /dev/null`;

class IBusManager implements LinuxIMEManager {
    private logger: LogSink;
    private envPath: string;
    private currentMode: 'zh' | 'en';
    private englishEngine: string;
    private chineseEngine: string;

    constructor(logger: LogSink, envPath: string) {
        this.logger = logger;
        this.envPath = envPath;
        const config = vscode.workspace.getConfiguration('auto-ime.ibus');
        this.englishEngine = config.get<string>('englishEngine') || 'xkb:us::eng';
        this.chineseEngine = config.get<string>('chineseEngine') || 'libpinyin';
        const systemName = this.queryFromSystem();
        this.currentMode = systemName === this.englishEngine ? 'en' : 'zh';
        logger.info(`[IBus] Initial state: ${this.currentMode}`);
    }

    getEnglishEngine(): string { return this.englishEngine; }
    getChineseEngine(): string { return this.chineseEngine; }

    queryMode(): 'zh' | 'en' {
        return this.currentMode;
    }

    /**
     * Async mode query for polling (non-blocking)
     */
    async queryModeAsync(envPath: string): Promise<'zh' | 'en'> {
        try {
            const result = await runBashAsync('ibus engine', envPath, 1000);
            const systemName = result || this.englishEngine;
            this.currentMode = systemName === this.englishEngine ? 'en' : 'zh';
            return this.currentMode;
        } catch {
            return this.queryMode(); // Fallback to sync
        }
    }

    switchToEnglish(): SwitchResult {
        if (this.currentMode === 'en') {
            return { success: true, method: 'skip' };
        }
        this.currentMode = 'en';
        this.runBash(IBUS_ENGINE_SCRIPT, [this.englishEngine], `ibus engine ${this.englishEngine}`);
        return { success: true, method: 'ibus' };
    }

    switchToChinese(): SwitchResult {
        if (this.currentMode === 'zh') {
            return { success: true, method: 'skip' };
        }
        this.currentMode = 'zh';
        this.runBash(IBUS_ENGINE_SCRIPT, [this.chineseEngine], `ibus engine ${this.chineseEngine}`);
        return { success: true, method: 'ibus' };
    }

    queryFromSystem(): string {
        const result = this.runBash('ibus engine', [], 'ibus engine query');
        return result || this.englishEngine;
    }

    syncFromSystem(): void {
        const systemName = this.queryFromSystem();
        const systemMode: 'zh' | 'en' = systemName === this.englishEngine ? 'en' : 'zh';
        if (systemMode !== this.currentMode) {
            this.logger.info(`[IBus] Sync: ${this.currentMode} → ${systemMode}`);
            this.currentMode = systemMode;
        }
    }

    private runBash(script: string, args: string[], label: string): string {
        try {
            return runBash(script, args, this.envPath, 1000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[IBus] ${label} failed: ${message}`);
            return '';
        }
    }
}

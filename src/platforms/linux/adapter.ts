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
 * D-Bus event-driven:
 * - Fcitx5: listens to InputMethodChanged signal (instant, no polling)
 * - IBus: listens to GlobalEngineChanged signal (instant, no polling)
 *
 * Fcitx4 removed: deprecated project, users should migrate to Fcitx5
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { IPlatformAdapter, SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';
import { DbusIMEListener, FCITX5_DBUS, IBUS_DBUS, IMEChangeCallback } from './dbus-listener';

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

// ========== Linux Adapter ==========

export class LinuxAdapter implements IPlatformAdapter {
    readonly name = 'linux';
    private logger!: LogSink;
    private envPath!: string;
    private manager: LinuxIMEManager | null = null;
    private dbusListener: DbusIMEListener | null = null;
    private changeCallback: IMEChangeCallback | null = null;

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
        return this.manager.switchToEnglish();
    }

    switchToChinese(): SwitchResult {
        if (!this.manager) return { success: false, method: 'none' };
        return this.manager.switchToChinese();
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
     * Start D-Bus signal listening for external manual switches
     * Callback fires immediately when user switches via system tray
     */
    async startListening(callback: IMEChangeCallback): Promise<void> {
        this.changeCallback = callback;
        this.dbusListener = new DbusIMEListener(this.logger);

        if (this.manager instanceof Fcitx5Manager) {
            const englishTarget = this.manager.getEnglishTarget();
            await this.dbusListener.start(
                FCITX5_DBUS,
                (name) => name === englishTarget || name.includes('keyboard'),
                callback,
            );
        } else if (this.manager instanceof IBusManager) {
            const englishEngine = this.manager.getEnglishEngine();
            await this.dbusListener.start(
                IBUS_DBUS,
                (name) => name === englishEngine,
                callback,
            );
        }
    }

    dispose(): void {
        if (this.dbusListener) {
            this.dbusListener.stop();
            this.dbusListener = null;
        }
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

    private queryFromSystem(): string {
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
        this.currentMode = this.queryFromSystem();
        logger.info(`[IBus] Initial state: ${this.currentMode}`);
    }

    getEnglishEngine(): string { return this.englishEngine; }
    getChineseEngine(): string { return this.chineseEngine; }

    queryMode(): 'zh' | 'en' {
        return this.currentMode;
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

    syncFromSystem(): void {
        const systemMode = this.queryFromSystem();
        if (systemMode !== this.currentMode) {
            this.logger.info(`[IBus] Sync: ${this.currentMode} → ${systemMode}`);
            this.currentMode = systemMode;
        }
    }

    private queryFromSystem(): 'zh' | 'en' {
        const result = this.runBash('ibus engine', [], 'ibus engine query');
        if (!result) return 'en';
        return result === this.englishEngine ? 'en' : 'zh';
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

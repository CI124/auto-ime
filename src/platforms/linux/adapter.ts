/**
 * Linux Platform Adapter
 * Auto-detects and delegates to Fcitx5, Fcitx4, or IBus
 *
 * Business logic restored from v0.5.0:
 * - Fcitx5: reads ~/.config/fcitx5/profile to discover actual input method names
 * - Fcitx4: uses exit code based query (1=English, 2=Chinese)
 * - IBus: exact match against configured engine name
 * - PATH: ensures /usr/local/bin, /usr/bin, /bin are available
 * - Detection: uses bash -c "command -v ..." for reliable detection
 */

import { execFileSync } from 'child_process';
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

    init(logger: LogSink): void {
        this.logger = logger;
        this.envPath = buildEnvPath();
        logger.info(`[Linux] Using PATH: ${this.envPath}`);

        if (this.isFcitx5Available()) {
            this.manager = new Fcitx5Manager(logger, this.envPath);
            logger.info('[Linux] Using Fcitx5');
        } else if (this.isFcitx4Available()) {
            this.manager = new Fcitx4Manager(logger, this.envPath);
            logger.info('[Linux] Using Fcitx4');
        } else if (this.isIBusAvailable()) {
            this.manager = new IBusManager(logger, this.envPath);
            logger.info('[Linux] Using IBus');
        } else {
            logger.warn('[Linux] No supported IME framework detected');
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

    dispose(): void {
        // nothing to clean up
    }

    // ========== Detection (v0.5.0 logic: bash -c "command -v ...") ==========

    private isFcitx5Available(): boolean {
        return tryExecBash(
            'command -v fcitx5-remote >/dev/null 2>&1 && [ -f "$HOME/.config/fcitx5/profile" ]',
            this.envPath, 5000
        );
    }

    private isFcitx4Available(): boolean {
        return tryExecBash(
            'command -v fcitx-remote >/dev/null 2>&1',
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
}

// ========== Fcitx5 Manager (v0.5.0 logic: profile reading + exact match) ==========

const FCITX5_SWITCH_SCRIPT = `fcitx5-remote -s "$1"`;

class Fcitx5Manager implements LinuxIMEManager {
    private logger: LogSink;
    private envPath: string;
    private englishTarget: string;
    private chineseTarget: string;

    constructor(logger: LogSink, envPath: string) {
        this.logger = logger;
        this.envPath = envPath;
        const targets = readFcitx5Profile(logger);
        this.englishTarget = targets.english;
        this.chineseTarget = targets.chinese;
    }

    queryMode(): 'zh' | 'en' {
        const result = this.runBash('fcitx5-remote -n', [], 'fcitx5-remote -n');
        if (!result) return 'en';
        return result === this.englishTarget ? 'en' : 'zh';
    }

    switchToEnglish(): SwitchResult {
        this.runBash(FCITX5_SWITCH_SCRIPT, [this.englishTarget], `fcitx5-remote -s ${this.englishTarget}`);
        return { success: true, method: 'fcitx5' };
    }

    switchToChinese(): SwitchResult {
        this.runBash(FCITX5_SWITCH_SCRIPT, [this.chineseTarget], `fcitx5-remote -s ${this.chineseTarget}`);
        return { success: true, method: 'fcitx5' };
    }

    private runBash(script: string, args: string[], label: string): string {
        try {
            const result = runBash(script, args, this.envPath, 1000);
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Fcitx5] ${label} failed: ${message}`);
            return '';
        }
    }
}

// ========== Fcitx4 Manager (v0.5.0 logic: exit code based query) ==========

const FCITX4_SWITCH_SCRIPT = `timeout 5 fcitx-remote "$1" &> /dev/null`;

class Fcitx4Manager implements LinuxIMEManager {
    private logger: LogSink;
    private envPath: string;

    constructor(logger: LogSink, envPath: string) {
        this.logger = logger;
        this.envPath = envPath;
    }

    queryMode(): 'zh' | 'en' {
        // fcitx-remote exit code: 1=inactive(English), 2=active(Chinese)
        const result = this.runBash('fcitx-remote 2>/dev/null; echo $?', [], 'fcitx-remote query');
        const code = parseInt(result.trim(), 10);
        return code === 2 ? 'zh' : 'en';
    }

    switchToEnglish(): SwitchResult {
        this.runBash(FCITX4_SWITCH_SCRIPT, ['-c'], 'fcitx-remote -c');
        return { success: true, method: 'fcitx4' };
    }

    switchToChinese(): SwitchResult {
        this.runBash(FCITX4_SWITCH_SCRIPT, ['-o'], 'fcitx-remote -o');
        return { success: true, method: 'fcitx4' };
    }

    private runBash(script: string, args: string[], label: string): string {
        try {
            return runBash(script, args, this.envPath, 1000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Fcitx4] ${label} failed: ${message}`);
            return '';
        }
    }
}

// ========== IBus Manager (v0.5.0 logic: exact match against configured engine) ==========

const IBUS_ENGINE_SCRIPT = `ibus engine "$1" &> /dev/null`;

class IBusManager implements LinuxIMEManager {
    private logger: LogSink;
    private envPath: string;

    constructor(logger: LogSink, envPath: string) {
        this.logger = logger;
        this.envPath = envPath;
    }

    queryMode(): 'zh' | 'en' {
        const result = this.runBash('ibus engine', [], 'ibus engine query');
        if (!result) return 'en';
        const config = vscode.workspace.getConfiguration('auto-ime.ibus');
        const engEngine = config.get<string>('englishEngine') || 'xkb:us::eng';
        return result === engEngine ? 'en' : 'zh';
    }

    switchToEnglish(): SwitchResult {
        const config = vscode.workspace.getConfiguration('auto-ime.ibus');
        const engEngine = config.get<string>('englishEngine') || 'xkb:us::eng';
        this.runBash(IBUS_ENGINE_SCRIPT, [engEngine], `ibus engine ${engEngine}`);
        return { success: true, method: 'ibus' };
    }

    switchToChinese(): SwitchResult {
        const config = vscode.workspace.getConfiguration('auto-ime.ibus');
        const zhEngine = config.get<string>('chineseEngine') || 'libpinyin';
        this.runBash(IBUS_ENGINE_SCRIPT, [zhEngine], `ibus engine ${zhEngine}`);
        return { success: true, method: 'ibus' };
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

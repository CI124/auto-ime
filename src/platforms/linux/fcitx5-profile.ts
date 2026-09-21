/**
 * Fcitx5 profile 解析（从 platforms/linux/adapter.ts 机械拆出，逐字符保留解析逻辑）
 *
 * 读 ~/.config/fcitx5/profile 找出用户真实配置的英文/中文输入法名，因为
 * `fcitx5-remote -s <name>` 需要的是名字，而名字因人而异（rime / pinyin / shuangpin…）。
 * 解析失败或文件不存在一律回退到默认对，绝不让扩展起不来。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogSink } from '../../infra/logger';

const DEFAULT_ENGLISH = 'keyboard-us';
const DEFAULT_CHINESE = 'pinyin';
/** 中文输入法的优先级：显式配置过的常见方案优先于"碰巧排在第一个"的 */
const CHINESE_PRIORITY = ['rime', 'pinyin', 'shuangpin'];
const GROUP_ITEM_SECTION = /^\[Groups\/0\/Items\/\d+\]$/;

export interface Fcitx5Targets {
    english: string;
    chinese: string;
}

/** 收集 profile 里 [Groups/0/Items/N] 段下的输入法 Name（跳过名为"默认…"的组条目） */
function collectMethodNames(content: string): string[] {
    const methods: string[] = [];
    let inGroupItems = false;
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
            inGroupItems = GROUP_ITEM_SECTION.test(line);
            continue;
        }
        if (!inGroupItems) continue;
        if (line.startsWith('Name=') && !line.startsWith('Name=默认')) {
            methods.push(line.substring('Name='.length).trim());
        }
    }
    return methods;
}

function pickEnglish(candidates: string[]): string {
    const keyboards = candidates.filter((m) => m.includes('keyboard'));
    return keyboards.includes(DEFAULT_ENGLISH) ? DEFAULT_ENGLISH : (keyboards[0] || DEFAULT_ENGLISH);
}

function pickChinese(candidates: string[]): string {
    const nonKeyboard = candidates.filter((m) => !m.includes('keyboard'));
    return CHINESE_PRIORITY.find((p) => nonKeyboard.includes(p))
        || nonKeyboard[0]
        || DEFAULT_CHINESE;
}

export function readFcitx5Profile(logger: LogSink): Fcitx5Targets {
    const profilePath = path.join(os.homedir(), '.config', 'fcitx5', 'profile');

    try {
        if (!fs.existsSync(profilePath)) {
            logger.info(`[Linux] fcitx5 profile not found: ${profilePath}`);
            return { english: DEFAULT_ENGLISH, chinese: DEFAULT_CHINESE };
        }

        const methods = collectMethodNames(fs.readFileSync(profilePath, 'utf-8'));
        const targets = { english: pickEnglish(methods), chinese: pickChinese(methods) };
        logger.info(`[Linux] fcitx5 profile loaded: english=${targets.english}, chinese=${targets.chinese}`);
        return targets;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Linux] Failed to read fcitx5 profile: ${message}`);
        return { english: DEFAULT_ENGLISH, chinese: DEFAULT_CHINESE };
    }
}

import * as fs from 'fs';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogSink = {
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};

const levelPriority: Record<LogLevel, number> = {
    'DEBUG': 0, 'INFO': 1, 'WARN': 2, 'ERROR': 3
};

const consoleMap: Record<LogLevel, (...args: any[]) => void> = {
    'DEBUG': console.log,
    'INFO': console.log,
    'WARN': console.warn,
    'ERROR': console.error
};

/**
 * 创建统一的 Logger 实例
 * 所有日志同时写入：console + Output Channel + 日志文件
 * 格式统一：[ISO-timestamp] [LEVEL] [TAG] message
 */
export function createLogger(
    tag: string,
    outputChannel?: { appendLine(msg: string): void },
    logFilePath?: string,
    minLevel: LogLevel = 'DEBUG'
): LogSink {
    function write(level: LogLevel, message: string) {
        if (levelPriority[level] < levelPriority[minLevel]) return;
        const ts = new Date().toISOString();
        const formatted = `[${ts}] [${level}] [${tag}] ${message}`;
        const bareMessage = `[${level}] [${tag}] ${message}`;

        consoleMap[level](formatted);
        outputChannel?.appendLine(bareMessage);
        if (logFilePath) {
            try { fs.appendFileSync(logFilePath, formatted + '\n'); } catch {}
        }
    }

    return {
        debug: (msg) => write('DEBUG', msg),
        info: (msg) => write('INFO', msg),
        warn: (msg) => write('WARN', msg),
        error: (msg) => write('ERROR', msg),
    };
}

/**
 * 创建空 Logger（用于测试或降级场景）
 */
export function createNullLogger(): LogSink {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    };
}

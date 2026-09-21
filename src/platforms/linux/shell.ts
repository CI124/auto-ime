/**
 * Linux 平台的 shell 执行原语（从 platforms/linux/adapter.ts 机械拆出，行为逐字保留）
 *
 * 为什么单独成文：适配器原本同时承担"bash 执行 + fcitx5 profile 解析 + 框架探测 +
 * 自适应轮询 + manager 分发"五种职责，文件长度已顶到粒度门禁的软上限。
 * 这里只放与"怎么跑一条命令"有关的细节；"跑哪条命令"仍归适配器与各 manager。
 */

import { exec, execFileSync } from 'child_process';

/** 输入法框架探测（command -v）允许耗时较长 */
export const DETECT_TIMEOUT_MS = 5000;
/** 状态查询 / 切换命令必须快速返回，不阻塞编辑器 */
export const QUERY_TIMEOUT_MS = 1000;

/** 补齐常见 bin 目录：从图形会话之外的环境启动时 PATH 往往不含它们 */
export function buildEnvPath(): string {
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

/** runBash / runBashAsync / tryExecBash 共用的 exec 选项（编码 / 超时 / PATH 环境） */
function execOptions(timeout: number, envPath: string) {
    return {
        encoding: 'utf-8' as const,
        timeout,
        env: { ...process.env, PATH: envPath },
    };
}

/**
 * 同步执行 bash 脚本；`args` 以 argv 传入（$1、$2…），不做字符串拼接，
 * 因此来自用户 profile / 配置的输入法名称不会被当成语句执行。
 */
export function runBash(script: string, args: string[], envPath: string, timeout: number): string {
    return execFileSync('bash', ['-c', script, 'bash_script.sh', ...args], execOptions(timeout, envPath)).trim();
}

/** 异步版：仅用于轮询探针，避免阻塞游标移动热路径 */
export function runBashAsync(script: string, envPath: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(`bash -c '${script}'`, execOptions(timeout, envPath), (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

/** 只关心成功与否的探测；失败不外泄 */
export function tryExecBash(script: string, envPath: string, timeout: number): boolean {
    try {
        execFileSync('bash', ['-c', script, 'bash_script.sh'], execOptions(timeout, envPath));
        return true;
    } catch {
        return false;
    }
}

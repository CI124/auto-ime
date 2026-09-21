/**
 * ValuePoller — 轮询一个只读探针，值发生变化时回调
 *
 * 用途：检测「用户在编辑器之外手动切换输入法」（系统托盘 / 全局热键）。
 * 平台适配器各自持有自己的探针，因为「怎么读当前输入法」是平台细节：
 * - Linux：`fcitx5-remote -n` / `ibus engine`，异步读以免阻塞光标移动热路径
 * - Windows 双键盘：读前台线程的 Language ID
 *
 * 间隔在每次排程时通过 `interval()` 重新求值，因此支持自适应间隔
 * （Linux：活跃 100ms、空闲 500ms）。首次读取只建立基线，不触发回调；
 * 单次读取失败交给 `onError`，不中断轮询。
 */
export class ValuePoller<T> {
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private last: T | undefined;

    constructor(
        private readonly read: () => T | Promise<T>,
        private readonly onChange: (value: T, previous: T) => void,
        private readonly interval: () => number,
        private readonly onError: (error: unknown) => void = () => {},
    ) {}

    isRunning(): boolean {
        return this.running;
    }

    start(): void {
        if (this.running) return;
        this.running = true;

        const tick = async () => {
            if (!this.running) return;
            try {
                const value = await this.read();
                const previous = this.last;
                this.last = value;
                if (previous !== undefined && previous !== value) {
                    this.onChange(value, previous);
                }
            } catch (error) {
                this.onError(error);
            }
            if (this.running) {
                this.timer = setTimeout(tick, this.interval());
            }
        };

        void tick();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.last = undefined;
    }
}

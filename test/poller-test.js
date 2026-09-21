/**
 * ValuePoller 单元测试 —— 针对【真实源码】
 *
 * ValuePoller 是"外部切换检测"的唯一轮询原语（Linux 每 100ms 起一个 bash 子进程、
 * Windows 每 150ms 一次 FFI 调用）。它现在多了 pause/resume（窗口失焦暂停），
 * 语义必须被锁住：
 *   - start 后首次读取只建立基线，不触发回调
 *   - 值变化才回调，且回调里能拿到旧值
 *   - pause 停止排程但保留基线；resume 继续用同一基线（失焦期间的真实切换
 *     会在恢复后被判为一次外部切换 —— 这正是期望语义，不是误报）
 *   - stop 清空基线
 *   - 单次读取抛错只走 onError，不中断轮询
 *   - interval 每次排程重新求值（自适应间隔的前提）
 *
 * 用 esbuild 现场把真实 src/core/poller.ts 打包为内存模块并加载。
 * 运行：node test/poller-test.js
 */

const assert = require('assert');
const path = require('path');
const esbuild = require('esbuild');

const REPO_ROOT = path.join(__dirname, '..');

function loadValuePoller() {
    const result = esbuild.buildSync({
        stdin: {
            contents: `export { ValuePoller } from './src/core/poller';`,
            resolveDir: REPO_ROOT,
            loader: 'ts',
            sourcefile: 'poller-entry.ts',
        },
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const mod = { exports: {} };
    new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
        mod.exports, require, mod, path.join(REPO_ROOT, 'poller-entry.js'), REPO_ROOT
    );
    return mod.exports.ValuePoller;
}

const ValuePoller = loadValuePoller();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let testCount = 0, passCount = 0, failCount = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/** 可控的"探针"：每次读取返回 currentValue()，并累计读取次数 */
function makeProbe(initial) {
    const state = { value: initial, reads: 0, throws: 0 };
    return {
        state,
        read: () => {
            state.reads++;
            if (state.throwOnce > 0) {
                state.throwOnce--;
                throw new Error('probe failed');
            }
            return state.value;
        },
    };
}

function makePoller(probe, opts = {}) {
    const changes = [];
    const errors = [];
    let intervals = opts.intervals || [5];
    let i = 0;
    const poller = new ValuePoller(
        probe.read,
        (value, previous) => changes.push({ value, previous }),
        () => {
            const v = intervals[Math.min(i, intervals.length - 1)];
            i++;
            return v;
        },
        (e) => errors.push(String(e.message || e))
    );
    return { poller, changes, errors };
}

// ============================================================
// 用例
// ============================================================

test('首次读取只建立基线，不触发 onChange', async () => {
    const probe = makeProbe('en');
    const { poller, changes } = makePoller(probe);
    poller.start();
    await sleep(30);
    poller.stop();
    assert.ok(probe.state.reads >= 1, '应至少读取一次');
    assert.deepStrictEqual(changes, [], '基线阶段不应有变化回调');
});

test('值变化才回调，且携带旧值', async () => {
    const probe = makeProbe('en');
    const { poller, changes } = makePoller(probe);
    poller.start();
    await sleep(20);
    probe.state.value = 'zh';
    await sleep(20);
    poller.stop();
    assert.strictEqual(changes.length, 1, `应只回调一次，实际 ${changes.length}`);
    assert.deepStrictEqual(changes[0], { value: 'zh', previous: 'en' });
});

test('单次读取抛错走 onError，不中断轮询', async () => {
    const probe = makeProbe('en');
    const { poller, errors } = makePoller(probe);
    poller.start();
    await sleep(15);
    probe.state.throwOnce = 1;
    await sleep(25);
    const readsAfterError = probe.state.reads;
    await sleep(25);
    poller.stop();
    assert.ok(errors.includes('probe failed'), '错误应交给 onError');
    assert.ok(probe.state.reads > readsAfterError, '抛错后仍要继续排程');
});

test('interval 每次排程重新求值（自适应间隔的前提）', async () => {
    const probe = makeProbe('en');
    // 前两次 5ms，之后 200ms：若 interval 被缓存，第二次之后的读取就不会变慢
    const { poller } = makePoller(probe, { intervals: [5, 5, 200, 200, 200] });
    poller.start();
    await sleep(40);
    const early = probe.state.reads;
    await sleep(40);
    const later = probe.state.reads;
    poller.stop();
    assert.ok(early >= 3, `5ms 间隔时应已读多次，实际 ${early}`);
    assert.strictEqual(later, early, '切到 200ms 后这 40ms 内不应继续读取（说明间隔被重新求值）');
});

test('pause 停止排程但保留基线；失焦期间的切换在恢复后计为一次外部切换', async () => {
    const probe = makeProbe('en');
    const { poller, changes } = makePoller(probe);
    poller.start();
    await sleep(20);
    assert.strictEqual(typeof poller.pause, 'function', 'ValuePoller 必须提供 pause()');
    assert.strictEqual(typeof poller.resume, 'function', 'ValuePoller 必须提供 resume()');

    poller.pause();
    const atPause = probe.state.reads;
    await sleep(30);
    assert.strictEqual(probe.state.reads, atPause, 'pause 后不得继续读取（失焦就该停开销）');
    assert.strictEqual(poller.isRunning(), false, 'pause 应表现为未运行');

    probe.state.value = 'zh'; // 用户在别的程序里手动切了输入法
    await sleep(20);
    assert.strictEqual(probe.state.reads, atPause, 'pause 期间即使值变了也不能被读取');

    poller.resume();
    await sleep(30);
    assert.strictEqual(poller.isRunning(), true, 'resume 后应恢复排程');
    assert.deepStrictEqual(changes, [{ value: 'zh', previous: 'en' }],
        '恢复后应把失焦期间的真实切换判为一次外部切换（保留基线才有这个语义）');
    poller.stop();
});

test('stop 清空基线；start 可再次启动并重新建立基线', async () => {
    const probe = makeProbe('en');
    const { poller, changes } = makePoller(probe);
    poller.start();
    await sleep(15);
    poller.stop();
    probe.state.value = 'zh';
    poller.start();
    await sleep(25);
    poller.stop();
    assert.deepStrictEqual(changes, [], 'stop 后基线被清空，重新启动应把它当新基线');
});

test('pause 在未 start 时是空操作，resume 在 stop 后不复活', async () => {
    const probe = makeProbe('en');
    const { poller } = makePoller(probe);
    poller.pause();            // 未启动过
    poller.start();
    await sleep(15);
    poller.pause();
    poller.stop();
    poller.resume();           // stop 之后不允许复活
    const reads = probe.state.reads;
    await sleep(30);
    assert.strictEqual(probe.state.reads, reads, 'stop 后 resume 不应恢复轮询');
    assert.strictEqual(poller.isRunning(), false);
});

// ============================================================

(async () => {
    console.log('═══════════════════════════════════════');
    console.log('  ValuePoller 行为测试（真实源码）');
    console.log('═══════════════════════════════════════\n');
    for (const item of queue) {
        testCount++;
        try {
            await item.fn();
            passCount++;
            console.log(`  ✅ ${item.name}`);
        } catch (e) {
            failCount++;
            console.log(`  ❌ ${item.name}`);
            console.log(`     ${e.message}`);
        }
    }
    console.log('\n═══════════════════════════════════════');
    console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
    console.log('═══════════════════════════════════════');
    process.exit(failCount > 0 ? 1 : 0);
})().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});

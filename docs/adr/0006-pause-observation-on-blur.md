# ADR 0006: 窗口失焦暂停外部切换轮询（而非加自适应间隔）

- 状态：Accepted
- 日期：2026-09-21
- 相关：`src/core/poller.ts`（`pause`/`resume`）、`src/core/types.ts`
  （`IPlatformAdapter.setObserving?`）、`src/extension.ts`（`registerFocusSync`）

## 背景

外部（用户在编辑器之外手动切换输入法）检测靠 `ValuePoller` 轮询平台探针：

- Linux：每 100ms（活跃）/ 500ms（空闲）**起一个 bash 子进程**执行 `fcitx5-remote -n`；
- Windows 双键盘：固定 150ms 一次 `GetKeyboardLayout` FFI 调用。

窗口没有焦点时，扩展既不会分析游标也不会切换输入法，轮询到的变化最多只能用来更新
状态栏 —— 而状态栏在失焦期间没人看。也就是说这段开销对用户**完全不产生价值**。
Linux 侧尤其浪费：挂机一小时约 3.6 万次子进程。

## 决策

1. `ValuePoller` 增加 `pause()` / `resume()`，与 `stop()` 区别开：
   **pause 保留基线**，因此用户在别的程序里改的输入法会在恢复焦点后被上报一次
   （语义正确：那确实是一次外部切换），而不是被静默吞掉。`stop()` 丢基线并使
   `resume()` 失效，避免"已释放的定时器被复活"。
2. `IPlatformAdapter` 增加可选 `setObserving?(observing: boolean)`；两平台适配器
   转发给自己的 poller（Linux 恢复时顺带刷新"最后活动时刻"，先回到活跃间隔）。
3. `IMEStateTracker.setObserving()` 只做转发（它不自建定时器，这条约束不变）。
4. `extension.ts` 在 `onDidChangeWindowState` 里先 `setObserving(e.focused)`，
   获得焦点时再走原有的 `syncState()` 分支。

## 被否决：给 Windows 也做自适应间隔

巡检建议里包含"Windows 轮询改自适应"。实测成本核算后**不做**：Windows 探针是一次
`GetKeyboardLayout` 用户态调用（微秒级），而 Linux 是子进程（毫秒级 + 调度）。
失焦暂停已经消掉了 99% 的无意义开销；再为一次廉价 FFI 调用引入"活跃/空闲阈值"这个
新概念，属于**为指标而加复杂度**，且会让两平台的间隔语义不对称地扩散。
**复审触发**：若有人测到 Windows 侧轮询本身占用可测 CPU（目前无证据），再做。

## 代价

- 焦点事件与轮询状态之间多了一条链路；已用 `test/poller-test.js`（7 例）与
  `test/mock-tsf-test.js` 的"失焦后 `GetKeyboardLayout` 读取数不再增长"用例锁住。
- 若某平台将来需要在失焦时也同步状态（例如多窗口），需要把 `setObserving` 换成
  "按窗口计数"的引用计数，而不是布尔。

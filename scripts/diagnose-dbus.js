#!/usr/bin/env node
/**
 * Fcitx5 D-Bus 信号诊断脚本
 * 
 * 用途：监听所有 Fcitx5 相关 D-Bus 信号，确认按下切换键时哪些信号真正触发。
 * 运行：node scripts/diagnose-dbus.js
 * 操作：运行后按 Ctrl+Space 或 Shift 切换输入法，观察输出。
 */

const dbus = require('dbus-next');

async function main() {
    const bus = dbus.sessionBus();

    console.log('=== Fcitx5 D-Bus Signal Diagnostics ===\n');
    console.log('请在运行后按 Ctrl+Space / Shift 切换输入法，观察哪些信号触发。\n');
    console.log('按 Ctrl+C 退出。\n');

    // ========== 1. 列出 Fcitx5 所有 D-Bus 对象 ==========
    console.log('--- [1] Fcitx5 服务上的对象路径 ---');
    try {
        const rootObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/');
        const intro = rootObj.getInterface('org.freedesktop.DBus.Introspectable');
        const xml = await intro.Introspect();
        const paths = [...xml.matchAll(/<node name="([^"]+)"/g)].map(m => m[1]);
        console.log('根路径下的子节点:', paths);
    } catch (e) {
        console.log('无法连接 org.fcitx.Fcitx5:', e.message);
    }

    // ========== 2. Introspect /inputmethod ==========
    console.log('\n--- [2] /inputmethod 路径详情 ---');
    try {
        const obj = await bus.getProxyObject('org.fcitx.Fcitx5', '/inputmethod');
        const intro = obj.getInterface('org.freedesktop.DBus.Introspectable');
        const xml = await intro.Introspect();
        
        // 提取接口
        const ifaces = [...xml.matchAll(/<interface name="([^"]+)">/g)].map(m => m[1]);
        console.log('接口:', ifaces);
        
        // 提取信号
        const signals = [...xml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
        console.log('信号:', signals);
        
        // 提取方法
        const methods = [...xml.matchAll(/<method name="([^"]+)">/g)].map(m => m[1]);
        console.log('方法:', methods);
        
        // 提取属性
        const props = [...xml.matchAll(/<property name="([^"]+)"[^>]*access="([^"]+)"/g)]
            .map(m => `${m[1]} (${m[2]})`);
        console.log('属性:', props);
        
        // 打印完整 XML（截断）
        console.log('\n完整 Introspect XML (前 2000 字符):');
        console.log(xml.substring(0, 2000));
    } catch (e) {
        console.log('无法 introspect /inputmethod:', e.message);
    }

    // ========== 3. 创建 InputContext ==========
    console.log('\n--- [3] 创建 InputContext ---');
    let contextPath = null;
    let contextObj = null;
    try {
        const inputMethodObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/inputmethod');
        const inputMethodIface = inputMethodObj.getInterface('org.fcitx.Fcitx.InputMethod1');
        
        if (inputMethodIface) {
            console.log('InputMethod1 接口方法:');
            // 尝试列出方法（通过 introspect）
            const intro = inputMethodObj.getInterface('org.freedesktop.DBus.Introspectable');
            const xml = await intro.Introspect();
            const inputMethodSection = xml.match(/<interface name="org\.fcitx\.Fcitx\.InputMethod1">([\s\S]*?)<\/interface>/);
            if (inputMethodSection) {
                console.log(inputMethodSection[1].substring(0, 1000));
            }
            
            contextPath = await inputMethodIface.CreateInputContext('auto-ime-diag', 'diagnostic');
            console.log(`\nInputContext 创建成功: ${contextPath}`);
            
            // Introspect InputContext
            contextObj = await bus.getProxyObject('org.fcitx.Fcitx5', contextPath);
            const ctxIntro = contextObj.getInterface('org.freedesktop.DBus.Introspectable');
            const ctxXml = await ctxIntro.Introspect();
            
            const ctxIfaces = [...ctxXml.matchAll(/<interface name="([^"]+)">/g)].map(m => m[1]);
            console.log('InputContext 接口:', ctxIfaces);
            
            const ctxSignals = [...ctxXml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
            console.log('InputContext 信号:', ctxSignals);
            
            const ctxMethods = [...ctxXml.matchAll(/<method name="([^"]+)">/g)].map(m => m[1]);
            console.log('InputContext 方法:', ctxMethods);
            
            console.log('\nInputContext 完整 XML (前 3000 字符):');
            console.log(ctxXml.substring(0, 3000));
        } else {
            console.log('InputMethod1 接口不存在');
        }
    } catch (e) {
        console.log(`创建 InputContext 失败: ${e.message}`);
    }

    // ========== 4. 监听所有 Fcitx5 信号 ==========
    console.log('\n--- [4] 开始监听信号 (切换输入法测试) ---\n');

    // 4a. 监听 InputMethod1 上的信号
    try {
        const imObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/inputmethod');
        const imIface = imObj.getInterface('org.fcitx.Fcitx.InputMethod1');
        if (imIface) {
            const events = ['InputMethodChanged', 'StatusChanged', 'IMStateChanged',
                           'CurrentInputMethodChanged', 'InputMethodGroupChanged'];
            for (const evt of events) {
                try {
                    imIface.on(evt, (...args) => {
                        console.log(`[Signal] /inputmethod ${evt}:`, args);
                    });
                    console.log(`  监听: /inputmethod → ${evt}`);
                } catch {}
            }
        }
    } catch (e) {
        console.log('监听 /inputmethod 失败:', e.message);
    }

    // 4b. 监听 InputContext 上的信号
    if (contextObj) {
        try {
            const ctxIface = contextObj.getInterface('org.fcitx.Fcitx.InputContext1');
            if (ctxIface) {
                const events = ['CurrentIM', 'CommitString', 'ForwardKey',
                               'UpdatePreedit', 'UpdateClientSideUI', 'StatusChanged',
                               'IMStateChanged'];
                for (const evt of events) {
                    try {
                        ctxIface.on(evt, (...args) => {
                            console.log(`[Signal] InputContext ${evt}:`, args);
                        });
                        console.log(`  监听: InputContext → ${evt}`);
                    } catch {}
                }
            }
        } catch (e) {
            console.log('监听 InputContext 失败:', e.message);
        }
    }

    // 4c. 监听 PropertiesChanged（D-Bus 标准信号）
    try {
        const matchRule = `type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'`;
        // dbus-next 不直接支持 addMatch，但可以通过 bus.addMatch 监听
        const busObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
        const dbusIface = busObj.getInterface('org.freedesktop.DBus');
        
        // 使用 addMatch 添加匹配规则
        try {
            await dbusIface.AddMatch(matchRule);
            console.log(`  监听: PropertiesChanged (via AddMatch)`);
        } catch (e) {
            console.log(`  AddMatch 失败: ${e.message}`);
        }
    } catch {}

    // 4d. 用 D-Bus monitor 监听所有 Fcitx5 相关信号
    console.log('\n  [提示] 如需更详细的信号分析，可另开终端运行:');
    console.log('  dbus-monitor "interface=\'org.fcitx.Fcitx.InputContext1\'"');
    console.log('  dbus-monitor "interface=\'org.fcitx.Fcitx.InputMethod1\'"');
    console.log('  dbus-monitor "interface=\'org.freedesktop.DBus.Properties\'"');

    // ========== 5. 轮询当前状态 ==========
    console.log('\n--- [5] 轮询 fcitx5-remote 状态 (用于对比) ---');
    const { execSync } = require('child_process');
    
    let lastState = '';
    setInterval(() => {
        try {
            const name = execSync('fcitx5-remote -n', { encoding: 'utf-8', timeout: 1000 }).trim();
            const state = execSync('fcitx5-remote', { encoding: 'utf-8', timeout: 1000 }).trim();
            const key = `${name}|${state}`;
            if (key !== lastState) {
                console.log(`[Poll] fcitx5-remote: name="${name}", state="${state}" (1=inactive, 2=active)`);
                lastState = key;
            }
        } catch {}
    }, 500);

    console.log('\n等待信号中... (按 Ctrl+C 退出)\n');
}

main().catch(console.error);

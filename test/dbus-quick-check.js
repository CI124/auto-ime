/**
 * 快速 D-Bus 连接检测脚本
 * 检测 Fcitx5/IBus 是否可用，并列出可用信号
 */

const dbus = require('dbus-next');

async function quickCheck() {
    console.log('🔍 Quick D-Bus Connection Check\n');
    
    const bus = dbus.sessionBus();
    const results = { fcitx5: false, ibus: false, signals: [] };
    
    // 检测 Fcitx5
    console.log('📡 Checking Fcitx5...');
    try {
        const obj = await bus.getProxyObject('org.fcitx.Fcitx5', '/inputmethod');
        const iface = obj.getInterface('org.fcitx.Fcitx.InputMethod1');
        if (iface) {
            console.log('✅ Fcitx5 InputMethod1 found');
            results.fcitx5 = true;
            
            // 创建 InputContext
            try {
                const ctxPath = await iface.CreateInputContext('quick-check', 'test');
                console.log(`✅ InputContext created: ${ctxPath}`);
                
                // 获取可用信号
                const ctxObj = await bus.getProxyObject('org.fcitx.Fcitx5', ctxPath);
                const introspectable = ctxObj.getInterface('org.freedesktop.DBus.Introspectable');
                const xml = await introspectable.Introspect();
                const signals = [...xml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
                console.log(`✅ Available signals: [${signals.join(', ')}]`);
                results.signals = signals;
            } catch (e) {
                console.log('⚠️  InputContext creation failed:', e.message);
            }
        }
    } catch (e) {
        console.log('❌ Fcitx5 not found:', e.message);
    }
    
    // 检测 IBus
    console.log('\n📡 Checking IBus...');
    try {
        const obj = await bus.getProxyObject('org.freedesktop.IBus', '/org/freedesktop/IBus');
        const iface = obj.getInterface('org.freedesktop.IBus');
        if (iface) {
            console.log('✅ IBus found');
            results.ibus = true;
        }
    } catch (e) {
        console.log('❌ IBus not found:', e.message);
    }
    
    // 检测 /controller
    console.log('\n📡 Checking /controller...');
    try {
        const obj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
        const iface = obj.getInterface('org.fcitx.Fcitx5.Controller1');
        if (iface) {
            console.log('✅ Controller1 found');
        }
    } catch (e) {
        console.log('❌ Controller not found:', e.message);
    }
    
    // 总结
    console.log('\n📊 Summary:');
    console.log(`   Fcitx5: ${results.fcitx5 ? '✅ Available' : '❌ Not available'}`);
    console.log(`   IBus: ${results.ibus ? '✅ Available' : '❌ Not available'}`);
    if (results.signals.length > 0) {
        console.log(`   Signals: ${results.signals.join(', ')}`);
    }
    
    return results;
}

quickCheck().catch(console.error);

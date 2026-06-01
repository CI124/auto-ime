const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sandboxDir = path.join(__dirname, '..', '.vscode-sandbox');
const extensionsDir = path.join(sandboxDir, 'extensions');

if (!fs.existsSync(extensionsDir)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
}

// 检查是否已安装 vscodevim.vim
const isInstalled = fs.readdirSync(extensionsDir).some(dir => dir.toLowerCase().includes('vscodevim.vim'));

if (isInstalled) {
    console.log('[Sandbox] vscodevim.vim is already installed in the sandbox.');
    process.exit(0);
}

console.log('[Sandbox] Installing vscodevim.vim into sandbox...');

const clis = ['code', 'code-insiders', 'vscodium'];
let installed = false;

for (const cli of clis) {
    try {
        // 尝试执行命令看是否存在
        execSync(`${cli} --version`, { stdio: 'ignore' });
        
        console.log(`[Sandbox] Using CLI: ${cli}`);
        // 下载并隔离安装
        execSync(`${cli} --extensions-dir "${extensionsDir}" --install-extension vscodevim.vim`, { stdio: 'inherit' });
        installed = true;
        break;
    } catch (e) {
        // 命令不存在或执行失败，继续尝试下一个
        continue;
    }
}

if (!installed) {
    console.error(`
[Error] Failed to install vscodevim.vim in the sandbox.
Could not find a valid VS Code CLI (tried: ${clis.join(', ')}).
Please manually run the following command to prepare the Sandbox:
code --extensions-dir .vscode-sandbox/extensions --install-extension vscodevim.vim
    `);
    process.exit(1);
} else {
    console.log('[Sandbox] Successfully prepared sandbox environment.');
}

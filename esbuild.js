const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const outDir = path.join(__dirname, 'out');

async function build() {
    // 确保输出目录存在
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    // 拷贝存放 AST 语言包的 wasm 目录
    const wasmSrc = path.join(__dirname, 'wasm');
    const wasmDest = path.join(outDir, 'wasm');
    if (fs.existsSync(wasmSrc)) {
        fs.cpSync(wasmSrc, wasmDest, { recursive: true });
        console.log('[Build] Copied language wasm files to out/wasm/');
    }

    // 提取并拷贝 web-tree-sitter 需要的内核 tree-sitter.wasm
    const coreWasmSrc = path.join(__dirname, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
    if (fs.existsSync(coreWasmSrc)) {
        fs.copyFileSync(coreWasmSrc, path.join(outDir, 'tree-sitter.wasm'));
        console.log('[Build] Copied core tree-sitter.wasm to out/');
    }

    const buildOptions = {
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'out/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        sourcemap: true,
    };

    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[Watch] Watching for file changes...');
    } else {
        await esbuild.build(buildOptions);
        console.log('[Build] Build complete.');
    }
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
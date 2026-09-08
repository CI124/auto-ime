# Auto IME

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/items?itemName=auto-ime)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **English** | [中文](README.md)

An intelligent input method auto-switching extension for **Linux** and **Windows**. Based on Tree-sitter AST parsing, it automatically switches between Chinese and English input methods based on code context. Supports both **VSCodeVim users** and **regular editor users**.

## Features

- **Dual mode support**: Auto-detects VSCodeVim extension, works for both Vim and regular users
- **Smart context detection**: Auto-switches to Chinese in comments, leaves strings unchanged
- **Instant response**: Text-based fast comment detection, immediate switch on `//`, `#` etc.
- **ESC force switch**: Vim ESC forces English input in Normal mode
- **Status bar**: Bottom-right status bar shows current IME state, click to toggle
- **Multi-language**: JavaScript, TypeScript, Python, Go, Rust, C, C++, CSS, HTML, Lua, Java, Kotlin, Bash
- **High performance**: Tree-sitter WASM incremental parsing + synchronous fast detection + dynamic debounce
- **Modular architecture**: Platform-agnostic core + platform-specific adapters

## Supported Languages

| Language | Line Comment | Block Comment | String | Template String |
|----------|-------------|---------------|--------|-----------------|
| JavaScript | `//` | `/* */` | `" '` | `` ` `` |
| TypeScript | `//` | `/* */` | `" '` | `` ` `` |
| Python | `#` | `""" '''` | `" '` | - |
| Go | `//` | `/* */` | `"` | `` ` `` |
| Rust | `//` `///` | `/* */` | `"` | `r#"..."#` |
| C/C++ | `//` | `/* */` | `"` | - |
| HTML | `<!-- -->` | - | - | - |
| Lua | `--` | `--[[ ]]` | `" '` | - |
| Java/Kotlin | `//` | `/* */` | `"` | - |
| Bash | `#` | - | `" '` | - |

## Installation

### VS Code Marketplace

```bash
code --install-extension CI124.auto-ime
```

### Manual (.vsix)

Download from [GitHub Releases](https://github.com/CI124/auto-ime/releases):

```bash
code --install-extension auto-ime-0.8.1.vsix
```

## Usage

1. Extension activates automatically after install
2. Status bar (bottom-right) shows current IME state (`EN` or `中`)
3. Click status bar to manually toggle

### Vim Mode

- In Insert mode: cursor in comment → Chinese; in code → English
- Press `ESC` → force English
- Supports `i`, `I`, `s`, `c` commands auto-detection

### Normal Mode

- Global analysis, no specific mode needed
- Auto-switches on `//`, `#` comment syntax

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `auto-ime.ibus.englishEngine` | `xkb:us::eng` | IBus English engine |
| `auto-ime.ibus.chineseEngine` | `libpinyin` | IBus Chinese engine |
| `auto-ime.windows.pollingInterval` | `150` | Windows polling interval (ms) |

## Supported IME Frameworks

| Platform | Framework | Description |
|----------|-----------|-------------|
| Linux | **Fcitx5** (recommended) | Adaptive polling + auto-reads profile |
| Linux | **IBus** | Adaptive polling + engine config |
| Windows | **Dual keyboard** | English(1033) ↔ Pinyin(2052), requires English keyboard |
| Windows | **TSF pipe** (experimental) | Single keyboard Chinese/English toggle |

## How It Works

1. **Event listening**: Mode listeners (Normal/Vim) monitor cursor and document changes
2. **Fast path**: Synchronous text detection for line/block comments
3. **AST parsing**: Tree-sitter incremental parsing, determines comment/string/code context
4. **Switch decision**: Only switches to Chinese in comments, strings unchanged
5. **Platform switch**: Adapter executes actual switch (Linux: shell commands, Windows: keyboard layout)
6. **External switch detection**: Linux via adaptive polling (100-500ms), Windows via polling
7. **Status bar**: Optimistic display update

## Development

```bash
npm install          # Install dependencies
npm run watch        # Watch mode
# Press F5 to debug
```

### Tests

```bash
node test/mock-koffi-test.js      # Windows (39 cases)
node test/mock-linux-ime-test.js  # Linux (70 cases)
node test/ast-analyzer-test.js    # AST (59 cases)
```

## FAQ

**Extension not working**: Check "Auto IME" output panel. Windows requires English(US) keyboard.

**IME not switching**: Linux: verify Fcitx5/IBus is running. Windows: check log for switch method.

**Performance**: Dynamic debounce (10-60ms) + incremental parsing (3x faster) + fast path detection.

## License

MIT License

## Acknowledgments

- [Tree-sitter](https://tree-sitter.github.io/) — Code parsing library
- [VSCodeVim](https://github.com/VSCodeVim/Vim) — Vim emulator
- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) — Tree-sitter WASM bindings

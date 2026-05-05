# Windows exe 打包说明

[English](PACKAGING.md) | [简体中文](PACKAGING.zh-CN.md)

本项目是 Electron + Vite + React 应用，可以使用 `electron-builder` 打包为 Windows `.exe`。

## 1. 安装依赖

如果还没有安装项目依赖，先执行：

```powershell
npm install
```

如果项目里还没有 Electron 打包工具，安装：

```powershell
npm install --save-dev electron-builder
```

## 2. 配置 package.json

在 `package.json` 的 `scripts` 中添加打包命令：

```json
"dist:win": "npm run build && electron-builder --win"
```

完整的 `scripts` 示例：

```json
"scripts": {
  "dev": "npm run build && electron .",
  "build": "tsc -p tsconfig.main.json && vite build",
  "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.main.json",
  "test": "vitest run",
  "dist:win": "npm run build && electron-builder --win"
}
```

然后在 `package.json` 根级添加 `build` 配置：

```json
"build": {
  "appId": "com.llm.gateway",
  "productName": "LLM Gateway",
  "files": [
    "dist/**/*",
    "package.json"
  ],
  "win": {
    "target": "nsis"
  }
}
```

`nsis` 会生成 Windows 安装包。

## 3. 生成安装版 exe

执行：

```powershell
npm run dist:win
```

打包完成后，生成文件通常在：

```text
dist\LLM Gateway Setup 0.1.0.exe
```

## 4. 生成免安装版 exe

如果想生成免安装版，修改 `package.json` 中的 `win.target`：

```json
"win": {
  "target": "portable"
}
```

然后重新执行：

```powershell
npm run dist:win
```

生成文件通常在：

```text
dist\LLM Gateway 0.1.0.exe
```

## 5. 常见问题

### electron-builder 命令不存在

确认已经执行：

```powershell
npm install --save-dev electron-builder
```

也可以直接运行本地依赖：

```powershell
npx electron-builder --win
```

### 打包前建议先检查

```powershell
npm run typecheck
npm test
npm run build
```

如果这些命令都通过，再执行：

```powershell
npm run dist:win
```

### PowerShell 提示脚本执行策略错误

如果 PowerShell 出现类似 `无法加载文件 ... Microsoft.PowerShell_profile.ps1` 的提示，通常不影响 npm 命令执行。也可以用不加载配置文件的方式运行：

```powershell
powershell -NoProfile
```

然后在新打开的 PowerShell 中重新执行打包命令。

# Windows exe Packaging

[English](PACKAGING.md) | [简体中文](PACKAGING.zh-CN.md)

This project is an Electron + Vite + React app. It can be packaged as a Windows `.exe` with `electron-builder`.

## 1. Install Dependencies

If project dependencies are not installed yet, run:

```powershell
npm install
```

Install the Electron packaging tool if it is not already present:

```powershell
npm install --save-dev electron-builder
```

## 2. Configure package.json

Add the packaging command to `scripts`:

```json
"dist:win": "npm run build && electron-builder --win"
```

Example `scripts` section:

```json
"scripts": {
  "dev": "npm run build && electron .",
  "build": "tsc -p tsconfig.main.json && vite build",
  "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.main.json",
  "test": "vitest run",
  "dist:win": "npm run build && electron-builder --win"
}
```

Add a top-level `build` config in `package.json`:

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

`nsis` generates a Windows installer.

## 3. Build The Installer exe

Run:

```powershell
npm run dist:win
```

After packaging, the generated file is usually in:

```text
dist\LLM Gateway Setup 0.1.0.exe
```

## 4. Build A Portable exe

To generate a portable executable, change `win.target` in `package.json`:

```json
"win": {
  "target": "portable"
}
```

Then run again:

```powershell
npm run dist:win
```

The generated file is usually in:

```text
dist\LLM Gateway 0.1.0.exe
```

## 5. Common Issues

### electron-builder command not found

Make sure you have run:

```powershell
npm install --save-dev electron-builder
```

You can also run the local dependency directly:

```powershell
npx electron-builder --win
```

### Check before packaging

Before packaging, run:

```powershell
npm run typecheck
npm test
npm run build
```

If all commands pass, run:

```powershell
npm run dist:win
```

### PowerShell execution policy warning

If PowerShell prints a warning such as `cannot be loaded ... Microsoft.PowerShell_profile.ps1`, it usually does not block npm commands. You can also start PowerShell without loading the profile:

```powershell
powershell -NoProfile
```

Then run the packaging command again in the new PowerShell window.

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 系统信息接口
 */
export interface SystemInfo {
	platform: string;
	arch: string;
	nodeVersion: string;
	shell: string;
	shellPath?: string;  // shell 完整路径，如 /bin/zsh
	homeDir?: string;    // 用户主目录，如 /Users/username
}

/**
 * 获取系统信息section
 */
export function getSystemInfoSection(workspaceRoot: string, systemInfo: SystemInfo): string {
	const normalizedPlatform = systemInfo.platform.toLowerCase();
	// 注意：不能用 includes('win')，否则 "darwin" 会被误判为 Windows
	const isWindows = normalizedPlatform === 'win32' || normalizedPlatform === 'windows' || normalizedPlatform.startsWith('win');
	const isMac = normalizedPlatform === 'darwin' || normalizedPlatform === 'macos' || normalizedPlatform === 'mac';

	// 人类可读的 OS 名称（参考 Cline）
	const osDisplayName = isWindows ? `Windows (${systemInfo.platform})`
		: isMac ? `macOS (${systemInfo.platform} ${systemInfo.arch})`
		: `Linux (${systemInfo.platform})`;

	// Shell 显示：优先用完整路径，否则用名称
	const shellDisplay = systemInfo.shellPath || systemInfo.shell;

	const shellLower = systemInfo.shell.toLowerCase();
	const isPowerShell = shellLower.includes('powershell') || shellLower.includes('pwsh');
	const isGitBash = shellLower.includes('bash') || shellLower.includes('git');
	const isCmd = !isPowerShell && !isGitBash && (shellLower.includes('cmd') || isWindows);
	const windowsShellMode = isPowerShell ? 'PowerShell 模式' : isGitBash ? 'Git Bash 模式（类 Unix 环境）' : 'CMD 模式';

	const platformCommands = isWindows ? `
⚠️ 当前运行在 Windows 系统，必须严格遵守以下命令规范：

Shell: ${systemInfo.shell}（${windowsShellMode}）
${isGitBash ? `
✅ 当前使用 Git Bash，可以使用大部分 Unix 命令（ls、cat、grep、rm 等）
   路径使用正斜杠 /，变量用 $VAR，命令链用 && 或 ||
` : isCmd ? `
⚠️ 当前使用 CMD，只能使用 Windows CMD 命令，不能使用 Unix 命令
` : ''}

${!isGitBash ? `【禁止使用的 Unix 命令 → 必须替换为 Windows 等效命令】
${isPowerShell ? `- ls / ls -la       → Get-ChildItem 或 dir
- cat <file>        → Get-Content <file>
- rm / rm -rf       → Remove-Item / Remove-Item -Recurse -Force
- cp                → Copy-Item
- mv                → Move-Item
- mkdir -p          → New-Item -ItemType Directory -Force
- touch             → New-Item <file>
- grep              → Select-String
- find              → Get-ChildItem -Recurse
- echo $VAR         → $env:VAR 或 Write-Output
- export VAR=val    → $env:VAR = "val"
- chmod / chown     → Windows 不支持，使用 icacls 或忽略
- curl              → Invoke-WebRequest 或 curl.exe
- which             → Get-Command
- pwd               → Get-Location 或 $PWD
- clear             → Clear-Host` : `- ls / ls -la       → dir 或 dir /a
- cat <file>        → type <file>
- rm / rm -rf       → del（文件）/ rmdir /s /q（目录）
- cp                → copy / xcopy
- mv                → move
- mkdir -p          → mkdir（自动创建父目录）
- touch             → type nul > file.txt
- grep              → findstr
- find              → dir /s /b
- echo $VAR         → echo %VAR%
- export VAR=val    → set VAR=val
- chmod / chown     → Windows 不支持，使用 icacls 或忽略
- curl              → curl.exe
- which             → where
- pwd               → cd（不带参数）
- clear             → cls`}` : ''}

【路径规范】
${isGitBash
	? `- 路径使用正斜杠 /（Git Bash 支持）
- 可使用 ~ 表示用户主目录
- 绝对路径格式：/c/path/to/dir 或 C:/path/to/dir`
	: isPowerShell
		? `- 路径分隔符使用反斜杠 \\ 或正斜杠 /（PowerShell 兼容两者）
- 不能使用 ~ 表示路径，改用 $HOME 或 $env:USERPROFILE
- 绝对路径格式：C:\\path\\to\\dir 或 C:/path/to/dir`
		: `- 路径分隔符使用反斜杠 \\
- 不能使用 ~ 或 $HOME，改用 %USERPROFILE%
- 绝对路径格式：C:\\path\\to\\dir`}

【命令链接】
${isGitBash
	? `- 使用 && 连接（与 bash 一致）`
	: isPowerShell
		? `- 使用 ; 分号分隔多条命令
- 条件执行：if ($?) { 命令 }
- 注意：PowerShell 的 && 仅在 PS 7+ 支持`
		: `- 使用 && 连接（前一条成功才执行后一条）`}

【注意】
- npm/node/python/git 命令在所有 Shell 下均可使用
${isGitBash ? '- Git Bash 不支持 Windows 原生 GUI 程序调用' : '- 运行 .sh 脚本需要 Git Bash 或 WSL，不能直接在 CMD/PowerShell 执行'}` : isMac ? `
操作系统: macOS (${systemInfo.platform})
Shell: ${systemInfo.shell}

⚠️ 当前是 macOS 系统，使用标准 Unix/macOS 命令，严禁使用 Windows 命令（del、rmdir /s、type、copy、move、dir、cls 等）。路径使用正斜杠 /，可用 ~ 表示主目录，命令链接用 && 或 ||` : `
操作系统: Linux (${systemInfo.platform})
Shell: ${systemInfo.shell}

⚠️ 当前是 Linux 系统，使用标准 Unix/Linux 命令，严禁使用 Windows 命令。路径使用正斜杠 /，可用 ~ 表示主目录，命令链接用 && 或 ||。包管理器：apt/yum/dnf install <pkg>`;

	return `====

SYSTEM INFORMATION

操作系统: ${osDisplayName}
Default Shell: ${shellDisplay}
Home Directory: ${systemInfo.homeDir || '~'}
Current Working Directory: ${workspaceRoot}
Node.js 版本: ${systemInfo.nodeVersion}
${platformCommands}`;
}

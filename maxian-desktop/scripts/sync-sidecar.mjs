#!/usr/bin/env node
/**
 * 编译 maxian-server 为单文件二进制，并同步到 src-tauri/bin/。
 * 调用：
 *   node scripts/sync-sidecar.mjs             → 当前平台
 *   node scripts/sync-sidecar.mjs darwin-arm64
 *   node scripts/sync-sidecar.mjs all          → 所有平台（Bun 跨平台编译）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const SERVER_ROOT  = path.resolve(DESKTOP_ROOT, '..', 'maxian-server');
const SIDECAR_DIR  = path.join(DESKTOP_ROOT, 'src-tauri', 'bin');

function run(cmd, args, cwd) {
	console.log(`$ ${cmd} ${args.join(' ')}  (cwd=${path.relative(DESKTOP_ROOT, cwd)})`);
	const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
	if (r.status !== 0) {
		console.error(`命令失败 (exit=${r.status})`);
		process.exit(r.status ?? 1);
	}
}

const arg = (process.argv[2] ?? 'current').toLowerCase();

// 1. 让 server 先 build:bin 产出二进制到 maxian-server/bin/
const buildScript = arg === 'all' ? 'build:bin:all' : arg === 'current' ? 'build:bin' : `build:bin:${arg}`;
// yarn 走更稳（pnpm 会抱怨 lockfile 差异）
const yarnBin = 'yarn';
// 回退：如果 all 没定义专门脚本，则手动触发 all
if (arg === 'all') {
	run('node', [path.join(SERVER_ROOT, 'scripts', 'build-bin.mjs'), 'all'], SERVER_ROOT);
} else {
	run(yarnBin, [buildScript], SERVER_ROOT);
}

// 2. 把产物拷贝到 src-tauri/bin/
mkdirSync(SIDECAR_DIR, { recursive: true });
const SRC_BIN_DIR = path.join(SERVER_ROOT, 'bin');
const entries = existsSync(SRC_BIN_DIR)
	? (await import('node:fs')).readdirSync(SRC_BIN_DIR).filter(f => f.startsWith('maxian-server-'))
	: [];

if (entries.length === 0) {
	console.error(`未在 ${SRC_BIN_DIR} 找到任何 maxian-server-* 二进制`);
	process.exit(1);
}

for (const entry of entries) {
	const src = path.join(SRC_BIN_DIR, entry);
	const dst = path.join(SIDECAR_DIR, entry);
	copyFileSync(src, dst);
	const sizeMB = (statSync(dst).size / 1024 / 1024).toFixed(1);
	console.log(`✅ ${entry} (${sizeMB} MB) → src-tauri/bin/`);
}

console.log('[sync-sidecar] 完成');

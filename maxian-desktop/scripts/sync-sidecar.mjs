#!/usr/bin/env node
/**
 * 同步 maxian-server/bin/ 下的二进制到 src-tauri/bin/。
 * 若目标二进制不存在则自动调用 build-bin.mjs 生成。
 *
 * 调用：
 *   node scripts/sync-sidecar.mjs             → 当前平台
 *   node scripts/sync-sidecar.mjs darwin-arm64
 *   node scripts/sync-sidecar.mjs all          → 所有平台（Bun 跨平台编译）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const SERVER_ROOT  = path.resolve(DESKTOP_ROOT, '..', 'maxian-server');
const SIDECAR_DIR  = path.join(DESKTOP_ROOT, 'src-tauri', 'bin');
const SRC_BIN_DIR  = path.join(SERVER_ROOT, 'bin');

function run(cmd, args, cwd) {
	console.log(`$ ${cmd} ${args.join(' ')}  (cwd=${path.relative(DESKTOP_ROOT, cwd)})`);
	const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.status !== 0) {
		console.error(`命令失败 (exit=${r.status})`);
		process.exit(r.status ?? 1);
	}
}

const TARGETS_TABLE = {
	'darwin-arm64': 'maxian-server-aarch64-apple-darwin',
	'darwin-x64':   'maxian-server-x86_64-apple-darwin',
	'linux-x64':    'maxian-server-x86_64-unknown-linux-gnu',
	'linux-arm64':  'maxian-server-aarch64-unknown-linux-gnu',
	'win32-x64':    'maxian-server-x86_64-pc-windows-msvc.exe',
};

function currentKey() {
	return `${process.platform}-${process.arch}`;
}

const arg = (process.argv[2] ?? 'current').toLowerCase();
const key = arg === 'current' ? currentKey() : arg;

// 1. 若目标 binary 不存在，调用 build-bin.mjs 生成
const needBuild = arg === 'all'
	? true
	: !existsSync(path.join(SRC_BIN_DIR, TARGETS_TABLE[key] ?? ''));

if (needBuild) {
	console.log(`[sync-sidecar] 目标 binary 不存在，开始构建...`);
	// 先确保 TS 产物是新的。用 pnpm 跨平台触发（Windows 下是 pnpm.cmd）
	const pm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
	run(pm, ['run', 'build'], SERVER_ROOT);
	// 再跑 build-bin
	run('node', [path.join(SERVER_ROOT, 'scripts', 'build-bin.mjs'), arg === 'current' ? key : arg], SERVER_ROOT);
} else {
	console.log(`[sync-sidecar] 目标 binary 已存在，跳过构建`);
}

// 2. 把产物拷贝到 src-tauri/bin/
mkdirSync(SIDECAR_DIR, { recursive: true });
if (!existsSync(SRC_BIN_DIR)) {
	console.error(`[sync-sidecar] ${SRC_BIN_DIR} 不存在`);
	process.exit(1);
}
const entries = readdirSync(SRC_BIN_DIR).filter(f => f.startsWith('maxian-server-'));
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

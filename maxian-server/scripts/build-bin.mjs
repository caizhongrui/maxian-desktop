#!/usr/bin/env node
/**
 * 把 dist/cli.js 用 Bun --compile 打成单文件二进制。
 * 产物放在 ./bin/ 下，命名遵循 Tauri externalBin 规范：
 *   maxian-server-<RUST_TRIPLE>[.exe]
 *
 * 平台映射（Node process.platform/arch → Rust triple）：
 *   darwin-arm64 → aarch64-apple-darwin
 *   darwin-x64   → x86_64-apple-darwin
 *   linux-x64    → x86_64-unknown-linux-gnu
 *   linux-arm64  → aarch64-unknown-linux-gnu
 *   win32-x64    → x86_64-pc-windows-msvc
 *   win32-arm64  → aarch64-pc-windows-msvc
 *
 * 用法：
 *   node scripts/build-bin.mjs                 # 当前平台
 *   node scripts/build-bin.mjs darwin-arm64    # 指定平台
 *   node scripts/build-bin.mjs all             # 全平台（仅 Bun 支持交叉）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_CLI = path.join(ROOT, 'dist', 'cli.js');
const OUT_DIR  = path.join(ROOT, 'bin');

// Node platform-arch → Bun --target / Rust triple
const TARGETS = {
	'darwin-arm64': { bunTarget: 'bun-darwin-arm64',  rustTriple: 'aarch64-apple-darwin',       ext: '' },
	'darwin-x64':   { bunTarget: 'bun-darwin-x64',    rustTriple: 'x86_64-apple-darwin',        ext: '' },
	'linux-x64':    { bunTarget: 'bun-linux-x64',     rustTriple: 'x86_64-unknown-linux-gnu',   ext: '' },
	'linux-arm64':  { bunTarget: 'bun-linux-arm64',   rustTriple: 'aarch64-unknown-linux-gnu',  ext: '' },
	'win32-x64':    { bunTarget: 'bun-windows-x64',   rustTriple: 'x86_64-pc-windows-msvc',     ext: '.exe' },
	// win32-arm64: Bun 1.3 暂未提供 bun-windows-arm64 预编译目标，跳过
};

function currentKey() {
	return `${process.platform}-${process.arch}`;
}

function buildOne(key) {
	const t = TARGETS[key];
	if (!t) {
		console.error(`[build-bin] 未知目标：${key}。可选：${Object.keys(TARGETS).join(', ')}`);
		process.exit(1);
	}
	if (!existsSync(DIST_CLI)) {
		console.error(`[build-bin] 未找到 ${DIST_CLI}，请先 yarn build`);
		process.exit(1);
	}
	mkdirSync(OUT_DIR, { recursive: true });

	const outFile = path.join(OUT_DIR, `maxian-server-${t.rustTriple}${t.ext}`);
	console.log(`[build-bin] ${key} → ${path.relative(ROOT, outFile)}`);

	const args = [
		'build',
		'--compile',
		`--target=${t.bunTarget}`,
		`--outfile`, outFile,
		DIST_CLI,
	];
	const r = spawnSync('bun', args, { stdio: 'inherit', cwd: ROOT });
	if (r.status !== 0) {
		console.error(`[build-bin] ${key} 失败 (exit=${r.status})`);
		process.exit(r.status ?? 1);
	}
	console.log(`[build-bin] ✅ ${path.relative(ROOT, outFile)}`);
}

const arg = (process.argv[2] ?? currentKey()).toLowerCase();

if (arg === 'all') {
	for (const key of Object.keys(TARGETS)) buildOne(key);
} else {
	buildOne(arg);
}

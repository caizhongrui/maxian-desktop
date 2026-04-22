#!/usr/bin/env node
/**
 * 手工用 macOS 原生 hdiutil 把 .app 打包为 .dmg。
 * 绕过 Tauri 自带的 create-dmg（对中文 productName 参数解析有 bug）。
 *
 * 产出：src-tauri/target/release/bundle/dmg/<productName>_<version>_<arch>.dmg
 *
 * 仅 macOS 生效。其他平台下自动跳过。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');

if (process.platform !== 'darwin') {
	console.log('[make-dmg] 非 macOS，跳过');
	process.exit(0);
}

// 读取 tauri.conf.json 拿 productName + version
const tauriConf = JSON.parse(
	readFileSync(path.join(DESKTOP_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const productName = tauriConf.productName;
const version = tauriConf.version;

// CI 场景：tauri build --target X → bundle 在 target/X/release/bundle/
// 本地场景：tauri build → bundle 在 target/release/bundle/
// 优先用 TAURI_BUILD_TARGET 环境变量，否则按平台自动探测
const TARGET_TRIPLE = process.env.TAURI_BUILD_TARGET
	|| (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
const TARGET_ROOT   = path.join(DESKTOP_ROOT, 'src-tauri', 'target');
const CANDIDATES = [
	path.join(TARGET_ROOT, TARGET_TRIPLE, 'release', 'bundle'),  // 带 --target 的构建
	path.join(TARGET_ROOT,                'release', 'bundle'),  // 无 --target 的构建
];
const bundleDir = CANDIDATES.find(p => existsSync(path.join(p, 'macos')));
if (!bundleDir) {
	console.error(`[make-dmg] 未找到 bundle 目录，检查过:\n  ${CANDIDATES.join('\n  ')}`);
	console.error(`[make-dmg] 请先运行 pnpm tauri build [--target ${TARGET_TRIPLE}]`);
	process.exit(1);
}
const MACOS_BUNDLE_DIR = path.join(bundleDir, 'macos');
const DMG_DIR          = path.join(bundleDir, 'dmg');

// 找 .app
const apps = readdirSync(MACOS_BUNDLE_DIR).filter(f => f.endsWith('.app'));
if (apps.length === 0) {
	console.error(`[make-dmg] 未找到 .app，bundle 目录：${MACOS_BUNDLE_DIR}`);
	process.exit(1);
}
const appPath = path.join(MACOS_BUNDLE_DIR, apps[0]);

// arch 后缀：从 TARGET_TRIPLE 推断（而非 process.arch，因为可能交叉编译）
const arch = TARGET_TRIPLE.startsWith('aarch64') ? 'aarch64' : 'x64';
mkdirSync(DMG_DIR, { recursive: true });
const dmgName = `${productName}_${version}_${arch}.dmg`;
const dmgPath = path.join(DMG_DIR, dmgName);

// 先清旧
if (existsSync(dmgPath)) {
	try { unlinkSync(dmgPath); } catch {}
}

console.log(`[make-dmg] 源 .app: ${appPath}`);
console.log(`[make-dmg] 目标 dmg: ${dmgPath}`);
console.log(`[make-dmg] 卷名: ${productName}`);

// hdiutil create -srcfolder <app> -volname <name> -format UDZO -o <out>
// UDZO = bzip2-compressed read-only disk image（标准 DMG 格式）
const args = [
	'create',
	'-srcfolder', appPath,
	'-volname',   productName,
	'-format',    'UDZO',
	'-fs',        'HFS+',
	'-ov',         // 覆盖已存在的
	'-quiet',
	dmgPath,
];
console.log(`$ hdiutil ${args.join(' ')}`);

const r = spawnSync('hdiutil', args, { stdio: 'inherit' });
if (r.status !== 0) {
	console.error(`[make-dmg] hdiutil 失败 (exit=${r.status})`);
	process.exit(r.status ?? 1);
}

// 验证产物 + 大小
if (!existsSync(dmgPath)) {
	console.error(`[make-dmg] 产物未生成: ${dmgPath}`);
	process.exit(1);
}
const { statSync } = await import('node:fs');
const sizeMB = (statSync(dmgPath).size / 1024 / 1024).toFixed(1);
console.log(`[make-dmg] ✅ ${dmgName} (${sizeMB} MB)`);

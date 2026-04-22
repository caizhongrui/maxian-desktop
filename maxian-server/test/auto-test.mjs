#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Maxian Server — 自动测试脚本
 *--------------------------------------------------------------------------------------------*/

const BASE = process.env.MAXIAN_URL || 'http://127.0.0.1:4096';
const USER = process.env.MAXIAN_USER || 'maxian';
const PASS = process.env.MAXIAN_PASS || 'test123';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

let passed = 0;
let failed = 0;
const results = [];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GREY = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function log(msg) { process.stdout.write(msg); }

async function request(method, path, body) {
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': AUTH,
	};
	const opts = { method, headers };
	if (body !== undefined) opts.body = JSON.stringify(body);
	const res = await fetch(`${BASE}${path}`, opts);
	const text = await res.text();
	let data;
	try { data = JSON.parse(text); } catch { data = text; }
	return { status: res.status, data, ok: res.ok };
}

async function test(name, fn) {
	const start = Date.now();
	try {
		await fn();
		const ms = Date.now() - start;
		log(`  ${GREEN}✓${RESET} ${name} ${GREY}(${ms}ms)${RESET}\n`);
		passed++;
		results.push({ name, ok: true, ms });
	} catch (err) {
		const ms = Date.now() - start;
		log(`  ${RED}✗${RESET} ${name} ${GREY}(${ms}ms)${RESET}\n`);
		log(`    ${RED}${err.message}${RESET}\n`);
		failed++;
		results.push({ name, ok: false, ms, error: err.message });
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(a, b, field) {
	if (a !== b) throw new Error(`${field}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

async function section(title) {
	log(`\n${BOLD}${CYAN}━━━ ${title} ━━━${RESET}\n`);
}

// =================================================================
(async () => {
	log(`\n${BOLD}🧪 Maxian Server 自动测试${RESET}\n`);
	log(`${GREY}Server: ${BASE}${RESET}\n`);
	log(`${GREY}Auth:   ${USER}/${PASS}${RESET}\n`);

	// ─── 健康检查 ─────────────────────────
	await section('健康检查');

	await test('GET /health → 200 + ok', async () => {
		const r = await request('GET', '/health');
		assertEq(r.status, 200, 'status');
		assertEq(r.data.ok, true, 'ok');
		assert(typeof r.data.version === 'string', 'version');
		assert(typeof r.data.uptime === 'number', 'uptime');
	});

	await test('GET /version → 200', async () => {
		const r = await request('GET', '/version');
		assertEq(r.status, 200, 'status');
		assert(r.data.version, 'version');
	});

	// ─── 认证测试 ─────────────────────────
	await section('认证');

	await test('无 Auth → 401', async () => {
		const res = await fetch(`${BASE}/health`);
		assertEq(res.status, 401, 'status');
	});

	await test('错密码 → 401', async () => {
		const res = await fetch(`${BASE}/health`, {
			headers: { 'Authorization': 'Basic ' + Buffer.from('x:x').toString('base64') },
		});
		assertEq(res.status, 401, 'status');
	});

	// ─── 会话 CRUD ─────────────────────────
	await section('会话 CRUD');

	let sessionId;

	await test('GET /sessions (空列表)', async () => {
		const r = await request('GET', '/sessions');
		assertEq(r.status, 200, 'status');
		assert(Array.isArray(r.data.sessions), 'sessions is array');
	});

	await test('POST /sessions 创建', async () => {
		const r = await request('POST', '/sessions', {
			title: '自动测试会话',
			workspacePath: '/tmp',
			mode: 'code',
		});
		assertEq(r.status, 201, 'status');
		assert(r.data.id, 'id');
		assertEq(r.data.title, '自动测试会话', 'title');
		assertEq(r.data.status, 'idle', 'status');
		assertEq(r.data.messageCount, 0, 'messageCount');
		sessionId = r.data.id;
	});

	await test('GET /sessions/:id 获取', async () => {
		const r = await request('GET', `/sessions/${sessionId}`);
		assertEq(r.status, 200, 'status');
		assertEq(r.data.id, sessionId, 'id matches');
	});

	await test('GET /sessions/unknown → 404', async () => {
		const r = await request('GET', '/sessions/nonexistent-id');
		assertEq(r.status, 404, 'status');
	});

	await test('GET /sessions 列表包含新建', async () => {
		const r = await request('GET', '/sessions');
		assertEq(r.status, 200, 'status');
		const found = r.data.sessions.find(s => s.id === sessionId);
		assert(found, 'session found in list');
	});

	await test('POST /sessions/:id/messages 发送消息', async () => {
		const r = await request('POST', `/sessions/${sessionId}/messages`, {
			content: '你好 Maxian',
		});
		assertEq(r.status, 200, 'status');
		assert(r.data.messageId, 'messageId returned');
	});

	await test('消息后状态更新', async () => {
		const r = await request('GET', `/sessions/${sessionId}`);
		assertEq(r.data.status, 'running', 'status is running');
		assertEq(r.data.messageCount, 1, 'messageCount = 1');
	});

	await test('POST /sessions/:id/cancel 取消任务', async () => {
		const r = await request('POST', `/sessions/${sessionId}/cancel`);
		assertEq(r.status, 200, 'status');
		assertEq(r.data.ok, true, 'ok');
	});

	await test('取消后状态回到 idle', async () => {
		const r = await request('GET', `/sessions/${sessionId}`);
		assertEq(r.data.status, 'idle', 'status');
	});

	await test('DELETE /sessions/:id', async () => {
		const r = await request('DELETE', `/sessions/${sessionId}`);
		assertEq(r.status, 200, 'status');
	});

	await test('删除后 GET 返回 404', async () => {
		const r = await request('GET', `/sessions/${sessionId}`);
		assertEq(r.status, 404, 'status');
	});

	// ─── 工作区管理 ─────────────────────────
	await section('工作区管理');

	let workspaceId;

	await test('GET /workspaces (初始状态)', async () => {
		const r = await request('GET', '/workspaces');
		assertEq(r.status, 200, 'status');
		assert(Array.isArray(r.data.workspaces), 'workspaces array');
	});

	await test('POST /workspaces 添加 /tmp', async () => {
		const r = await request('POST', '/workspaces', { path: '/tmp' });
		assertEq(r.status, 201, 'status');
		assert(r.data.id, 'id');
		assertEq(r.data.name, 'tmp', 'name');
		workspaceId = r.data.id;
	});

	await test('POST /workspaces 不存在的路径 → 错误', async () => {
		const r = await request('POST', '/workspaces', { path: '/nonexistent_xxx_yyy' });
		assert(r.status >= 400, `expected error, got ${r.status}`);
	});

	await test('POST /workspaces 幂等（重复添加返回同一个）', async () => {
		const r = await request('POST', '/workspaces', { path: '/tmp' });
		assertEq(r.data.id, workspaceId, 'same id returned');
	});

	await test('GET /workspaces/:id/files 列文件', async () => {
		const r = await request('GET', `/workspaces/${workspaceId}/files`);
		assertEq(r.status, 200, 'status');
		assert(Array.isArray(r.data.files), 'files array');
	});

	await test('DELETE /workspaces/:id', async () => {
		const r = await request('DELETE', `/workspaces/${workspaceId}`);
		assertEq(r.status, 200, 'status');
	});

	// ─── 工具 ─────────────────────────
	await section('工具');

	await test('GET /tools (列表)', async () => {
		const r = await request('GET', '/tools');
		assertEq(r.status, 200, 'status');
		assert(Array.isArray(r.data.tools), 'tools array');
	});

	await test('POST /tools/execute (占位实现)', async () => {
		const r = await request('POST', '/tools/execute', {
			name: 'read_file',
			params: { path: '/etc/hostname' },
			toolUseId: 'test-1',
		});
		assertEq(r.status, 200, 'status');
		assert(r.data.success !== undefined || r.data.result !== undefined, 'has result or success');
	});

	// ─── 配置 ─────────────────────────
	await section('配置');

	await test('PUT /config/:key 设置', async () => {
		const r = await request('PUT', '/config/test.foo', { value: 'bar' });
		assertEq(r.status, 200, 'status');
	});

	await test('GET /config/:key 读取', async () => {
		const r = await request('GET', '/config/test.foo');
		assertEq(r.status, 200, 'status');
		assertEq(r.data.key, 'test.foo', 'key');
	});

	// ─── 批量并发 ─────────────────────────
	await section('并发压测');

	await test('10 并发创建会话', async () => {
		const promises = Array.from({ length: 10 }, (_, i) =>
			request('POST', '/sessions', {
				title: `并发-${i}`,
				workspacePath: '/tmp',
			})
		);
		const results = await Promise.all(promises);
		const ids = new Set();
		for (const r of results) {
			assertEq(r.status, 201, 'status');
			assert(r.data.id, 'id');
			ids.add(r.data.id);
		}
		assertEq(ids.size, 10, 'all ids unique');

		// 清理
		await Promise.all(
			[...ids].map(id => request('DELETE', `/sessions/${id}`))
		);
	});

	await test('100 并发 /health', async () => {
		const start = Date.now();
		const promises = Array.from({ length: 100 }, () => request('GET', '/health'));
		const results = await Promise.all(promises);
		const allOk = results.every(r => r.status === 200);
		assert(allOk, 'all 200');
		const ms = Date.now() - start;
		log(`     ${GREY}→ 100 req in ${ms}ms (${(100000 / ms).toFixed(0)} req/s)${RESET}\n`);
	});

	// ─── 参数验证 ─────────────────────────
	await section('参数验证');

	await test('POST /sessions 缺 workspacePath → 400', async () => {
		const r = await request('POST', '/sessions', { title: 'no ws' });
		assert(r.status >= 400, `expected 4xx, got ${r.status}`);
	});

	await test('POST /sessions 非法 mode → 400', async () => {
		const r = await request('POST', '/sessions', {
			workspacePath: '/tmp',
			mode: 'invalid-mode',
		});
		assert(r.status >= 400, `expected 4xx, got ${r.status}`);
	});

	await test('POST /workspaces 空 body → 400', async () => {
		const r = await request('POST', '/workspaces', {});
		assert(r.status >= 400, `expected 4xx, got ${r.status}`);
	});

	// ─── 结束 ─────────────────────────
	log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);
	log(`${BOLD}结果:${RESET}  `);
	log(`${GREEN}${passed} 通过${RESET}  `);
	if (failed > 0) log(`${RED}${failed} 失败${RESET}  `);
	log(`${GREY}共 ${passed + failed} 项${RESET}\n`);

	if (failed > 0) {
		log(`\n${RED}${BOLD}失败项：${RESET}\n`);
		for (const r of results) {
			if (!r.ok) log(`  - ${r.name}: ${r.error}\n`);
		}
	}

	log('\n');
	process.exit(failed > 0 ? 1 : 0);
})();

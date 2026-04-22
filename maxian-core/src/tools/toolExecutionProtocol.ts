/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const APPROVAL_REQUIRED_PREFIX = '__APPROVAL_REQUIRED__:';
export const USER_INPUT_REQUIRED_PREFIX = '__USER_INPUT_REQUIRED__:';

export interface FollowupOption {
	label: string;
	description: string;
	value: string;
}

export interface FollowupRequestPayload {
	question: string;
	options: FollowupOption[];
	toolUseId?: string;
}

export interface ApprovalRequestPayload {
	command: string;
	cwd?: string;
	toolUseId?: string;
}

export type ToolInteractionRequest =
	| { type: 'followup'; payload: FollowupRequestPayload }
	| { type: 'approval'; payload: ApprovalRequestPayload };

const DEFAULT_FOLLOWUP_OPTIONS: FollowupOption[] = [
	{
		label: '继续当前方案（推荐）',
		description: '按当前分析继续执行，不再补充额外约束',
		value: '继续当前方案'
	},
	{
		label: '我先补充细节',
		description: '先提供额外背景或限制，再继续执行',
		value: '我先补充细节'
	},
	{
		label: '停止并说明原因',
		description: '暂停当前任务并给出阻塞原因',
		value: '停止并说明原因'
	}
];

function parseOptionsFromArray(values: unknown[]): FollowupOption[] {
	return values
		.map((item): FollowupOption | null => {
			if (typeof item === 'string') {
				const label = item.trim();
				if (!label) {
					return null;
				}
				return {
					label,
					description: '',
					value: label
				};
			}

			if (!item || typeof item !== 'object') {
				return null;
			}

			const raw = item as Record<string, unknown>;
			const label = String(raw.label || raw.value || '').trim();
			if (!label) {
				return null;
			}
			const description = String(raw.description || '').trim();
			const value = String(raw.value || label).trim() || label;
			return {
				label,
				description,
				value
			};
		})
		.filter((option): option is FollowupOption => !!option);
}

export function normalizeFollowupOptions(rawOptions: unknown): FollowupOption[] {
	if (Array.isArray(rawOptions)) {
		return parseOptionsFromArray(rawOptions);
	}

	if (typeof rawOptions === 'string' && rawOptions.trim().length > 0) {
		try {
			const parsed = JSON.parse(rawOptions);
			if (Array.isArray(parsed)) {
				return parseOptionsFromArray(parsed);
			}
		} catch {
			return rawOptions
				.split(/\r?\n|;/)
				.map(part => part.trim())
				.filter(Boolean)
				.map(label => ({ label, description: '', value: label }));
		}
	}

	return [];
}

export function ensureFollowupOptions(rawOptions: unknown, maxItems: number = 4): FollowupOption[] {
	const normalized = normalizeFollowupOptions(rawOptions);
	const deduped: FollowupOption[] = [];
	const seen = new Set<string>();

	for (const option of normalized) {
		const key = option.value.trim().toLowerCase();
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(option);
		if (deduped.length >= maxItems) {
			return deduped;
		}
	}

	for (const fallback of DEFAULT_FOLLOWUP_OPTIONS) {
		const key = fallback.value.trim().toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(fallback);
		if (deduped.length >= Math.max(2, Math.min(4, maxItems))) {
			break;
		}
	}

	return deduped.slice(0, Math.max(2, Math.min(4, maxItems)));
}

export function parseLegacyApprovalRequired(text: string): ApprovalRequestPayload | null {
	const normalized = (text || '').trim();
	if (!normalized.startsWith(APPROVAL_REQUIRED_PREFIX)) {
		return null;
	}
	const payloadText = normalized.slice(APPROVAL_REQUIRED_PREFIX.length);
	try {
		const payload = JSON.parse(payloadText) as Record<string, unknown>;
		return {
			command: String(payload.command || ''),
			cwd: payload.cwd ? String(payload.cwd) : '',
			toolUseId: payload.toolUseId ? String(payload.toolUseId) : undefined
		};
	} catch {
		return null;
	}
}

export function parseLegacyFollowupRequired(text: string): FollowupRequestPayload | null {
	const normalized = (text || '').trim();
	if (!normalized.startsWith(USER_INPUT_REQUIRED_PREFIX)) {
		return null;
	}
	const payloadText = normalized.slice(USER_INPUT_REQUIRED_PREFIX.length);
	try {
		const payload = JSON.parse(payloadText) as Record<string, unknown>;
		const question = String(payload.question || '').trim();
		if (!question) {
			return null;
		}
		return {
			question,
			options: ensureFollowupOptions(payload.options),
			toolUseId: payload.toolUseId ? String(payload.toolUseId) : undefined
		};
	} catch {
		return null;
	}
}

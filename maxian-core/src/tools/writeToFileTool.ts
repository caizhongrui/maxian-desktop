/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Complete implementation from Kilocode
import * as path from 'path';
import * as fs from 'fs';

import type { IToolContext } from './IToolContext.js';
import type { ToolResponse } from '../types/toolTypes.js';

export async function writeToFileTool(
	ctx: IToolContext,
	params: any,
): Promise<ToolResponse> {
	const filePath = params.path;
	let content = params.content;

	if (!filePath) {
		return 'Error: No file path provided';
	}

	if (content === undefined) {
		return 'Error: No content provided';
	}

	try {
		// Resolve absolute path
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(ctx.workspacePath, filePath);

		// Check if file exists
		const exists = fs.existsSync(absolutePath);
		const fileExists = exists;

		// Pre-process content (remove markdown code blocks if present)
		if (content.startsWith('```')) {
			content = content.split('\n').slice(1).join('\n');
		}
		if (content.endsWith('```')) {
			content = content.split('\n').slice(0, -1).join('\n');
		}

		// Create directory if it doesn't exist
		const dir = path.dirname(absolutePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// Write file
		fs.writeFileSync(absolutePath, content, 'utf-8');

		// Track file modification
		ctx.fileContextTracker.trackFileWrite(absolutePath, 'roo_edited');
		ctx.didEditFile = true;

		// FileTime：写入后刷新基线
		if (ctx.sessionId) {
			try {
				const { FileTime } = await import('../file/FileTime.js');
				FileTime.read(ctx.sessionId, absolutePath);
			} catch { /* ignore */ }
		}

		const lines = content.split('\n').length;
		const action = fileExists ? 'Updated' : 'Created';

		return [
			`${action} file: ${filePath}`,
			`Lines: ${lines}`,
			'',
			'File content has been successfully written.',
		].join('\n');
	} catch (error) {
		return `Error writing file: ${(error as Error).message}`;
	}
}

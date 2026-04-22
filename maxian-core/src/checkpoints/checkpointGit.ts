/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Complete Git integration for checkpoints from Kilocode
import { exec } from 'child_process';
import { promisify } from 'util';

import type { Task } from '../task/Task.js';

const execAsync = promisify(exec);

/**
 * Save a checkpoint by creating a Git commit
 */
export async function checkpointSave(task: Task, force: boolean = false, suppressMessage: boolean = false): Promise<void> {
	if (!task.enableCheckpoints) {
		return;
	}

	try {
		const cwd = task.workspacePath;

		// Check if we're in a git repository
		try {
			await execAsync('git rev-parse --git-dir', { cwd });
		} catch (error) {
			// Not a git repository, initialize one
			console.log('[Checkpoint] Initializing git repository');
			await execAsync('git init', { cwd });
			await execAsync('git config user.name "Maxian Agent"', { cwd });
			await execAsync('git config user.email "maxian@agent.local"', { cwd });
		}

		// Check if there are any changes
		const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd });
		if (!statusOutput.trim() && !force) {
			console.log('[Checkpoint] No changes to commit');
			return;
		}

		// Add all changes
		await execAsync('git add -A', { cwd });

		// Create commit with timestamp
		const timestamp = new Date().toISOString();
		const commitMessage = `Checkpoint: Task ${task.taskId} - ${timestamp}`;

		await execAsync(`git commit -m "${commitMessage}"`, { cwd });

		if (!suppressMessage) {
			await task.say('text', `Created checkpoint: ${commitMessage}`, undefined, false);
		}

		console.log(`[Checkpoint] Saved: ${commitMessage}`);
	} catch (error) {
		console.error('[Checkpoint] Save failed:', error);
		// Don't throw - checkpoint failures should not break the task
	}
}

/**
 * Restore to a previous checkpoint
 */
export async function checkpointRestore(task: Task, options: any): Promise<void> {
	if (!task.enableCheckpoints) {
		return;
	}

	try {
		const cwd = task.workspacePath;
		const commitHash = options.commit || 'HEAD~1'; // Default to previous commit

		// Confirm with user
		const { response } = await task.ask(
			'tool',
			`Are you sure you want to restore to checkpoint: ${commitHash}? This will discard current changes.`
		);

		if (response !== 'yesButtonTapped') {
			await task.say('text', 'Checkpoint restore cancelled');
			return;
		}

		// Reset to commit
		await execAsync(`git reset --hard ${commitHash}`, { cwd });

		await task.say('text', `Restored to checkpoint: ${commitHash}`, undefined, false);
		console.log(`[Checkpoint] Restored to: ${commitHash}`);
	} catch (error) {
		console.error('[Checkpoint] Restore failed:', error);
		await task.say('error', `Failed to restore checkpoint: ${(error as Error).message}`);
	}
}

/**
 * Show diff between current state and checkpoint
 */
export async function checkpointDiff(task: Task, options: any): Promise<void> {
	if (!task.enableCheckpoints) {
		return;
	}

	try {
		const cwd = task.workspacePath;
		const commitHash = options.commit || 'HEAD'; // Default to last commit

		// Get diff
		const { stdout: diffOutput } = await execAsync(`git diff ${commitHash}`, { cwd });

		if (!diffOutput.trim()) {
			await task.say('text', 'No differences found', undefined, false);
			return;
		}

		// Truncate if too long
		const maxDiffLength = 5000;
		const truncatedDiff = diffOutput.length > maxDiffLength
			? diffOutput.substring(0, maxDiffLength) + '\n\n... (diff truncated) ...'
			: diffOutput;

		await task.say('text', `Diff from ${commitHash}:\n\`\`\`diff\n${truncatedDiff}\n\`\`\``, undefined, false);
		console.log(`[Checkpoint] Showed diff from: ${commitHash}`);
	} catch (error) {
		console.error('[Checkpoint] Diff failed:', error);
		await task.say('error', `Failed to get diff: ${(error as Error).message}`);
	}
}

/**
 * List available checkpoints
 */
export async function checkpointList(task: Task): Promise<string[]> {
	if (!task.enableCheckpoints) {
		return [];
	}

	try {
		const cwd = task.workspacePath;

		// Get commit log
		const { stdout: logOutput } = await execAsync(
			'git log --oneline --max-count=10',
			{ cwd }
		);

		return logOutput.trim().split('\n').filter(Boolean);
	} catch (error) {
		console.error('[Checkpoint] List failed:', error);
		return [];
	}
}

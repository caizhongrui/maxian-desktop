/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/services/checkpoints/types.ts
// Complete type definitions

/**
 * Result of a checkpoint commit operation
 */
export type CheckpointResult = {
	commit: string;
	summary?: {
		changes: number;
		insertions: number;
		deletions: number;
	};
};

/**
 * Represents a diff between two checkpoint states
 */
export type CheckpointDiff = {
	paths: {
		relative: string;
		absolute: string;
	};
	content: {
		before: string;
		after: string;
	};
};

/**
 * Options for creating a checkpoint service
 */
export interface CheckpointServiceOptions {
	taskId: string;
	workspaceDir: string;
	shadowDir: string; // globalStorageUri.fsPath

	log?: (message: string) => void;
}

/**
 * Events emitted by checkpoint service
 */
export interface CheckpointEventMap {
	initialize: { type: 'initialize'; workspaceDir: string; baseHash: string; created: boolean; duration: number };
	checkpoint: {
		type: 'checkpoint';
		fromHash: string;
		toHash: string;
		duration: number;
		suppressMessage?: boolean;
	};
	restore: { type: 'restore'; commitHash: string; duration: number };
	error: { type: 'error'; error: Error };
}

/**
 * Options for checkpoint restore operation
 */
export type CheckpointRestoreOptions = {
	ts: number;
	commitHash: string;
	mode: 'preview' | 'restore';
	operation?: 'delete' | 'edit'; // Optional to maintain backward compatibility
};

/**
 * Options for checkpoint diff operation
 */
export type CheckpointDiffOptions = {
	ts?: number;
	previousCommitHash?: string;
	commitHash: string;
	/**
	 * from-init: Compare from the first checkpoint to the selected checkpoint.
	 * checkpoint: Compare the selected checkpoint to the next checkpoint.
	 * to-current: Compare the selected checkpoint to the current workspace.
	 * full: Compare from the first checkpoint to the current workspace.
	 */
	mode: 'from-init' | 'checkpoint' | 'to-current' | 'full';
};

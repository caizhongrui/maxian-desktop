/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/integrations/terminal/TerminalRegistry.ts
// Simplified stub for Phase 1 - Full VSCode terminal integration will be in Phase 2

import { RooTerminal, RooTerminalProvider } from './terminalTypes.js';

/**
 * NOTE: Phase 1 implementation - terminal registry functions are stubs.
 * Full terminal integration requires:
 * - VSCode terminal API integration
 * - Shell integration support
 * - Terminal process management
 * - Event handling for terminal lifecycle
 * These will be implemented in Phase 2.
 */

/**
 * Registry for managing terminal instances across tasks
 *
 * Although vscode.window.terminals provides a list of all open terminals,
 * there's no way to know whether they're busy or not (exitStatus does not
 * provide useful information for most commands). In order to prevent creating
 * too many terminals, we need to keep track of terminals through the life of
 * the extension, as well as session specific terminals for the life of a task
 * (to get latest unretrieved output).
 */
export class TerminalRegistry {
	private static terminals: RooTerminal[] = [];
	private static nextTerminalId = 1;
	private static isInitialized = false;

	/**
	 * Initializes the terminal registry
	 * Should only be called once during extension activation
	 */
	public static initialize(): void {
		if (this.isInitialized) {
			throw new Error('TerminalRegistry.initialize() should only be called once');
		}

		this.isInitialized = true;

		// Phase 1: No-op
		// Will be implemented in Phase 2 with VSCode terminal event handlers
		console.log('[TerminalRegistry] Initialized (Phase 1 stub)');
	}

	/**
	 * Creates a new terminal instance
	 *
	 * @param cwd - Working directory for the terminal
	 * @param provider - Terminal provider type ('vscode' or 'execa')
	 * @returns A new terminal instance
	 */
	public static createTerminal(cwd: string, provider: RooTerminalProvider): RooTerminal {
		// Phase 1: Return stub terminal
		// Will be implemented in Phase 2 with actual Terminal/ExecaTerminal instances
		const stubTerminal: RooTerminal = {
			provider,
			id: this.nextTerminalId++,
			busy: false,
			running: false,
			taskId: undefined,
			process: undefined,
			getCurrentWorkingDirectory: () => cwd,
			isClosed: () => false,
			runCommand: () => {
				throw new Error('Terminal runCommand not implemented in Phase 1');
			},
			setActiveStream: () => {},
			shellExecutionComplete: () => {},
			getProcessesWithOutput: () => [],
			getUnretrievedOutput: () => '',
			getLastCommand: () => '',
			cleanCompletedProcessQueue: () => {},
		};

		this.terminals.push(stubTerminal);
		return stubTerminal;
	}

	/**
	 * Gets an existing terminal or creates a new one for the given working directory
	 *
	 * @param cwd - The working directory path
	 * @param taskId - Optional task ID to associate with the terminal
	 * @param provider - Terminal provider type (default: 'vscode')
	 * @returns A terminal instance
	 */
	public static async getOrCreateTerminal(
		cwd: string,
		taskId?: string,
		provider: RooTerminalProvider = 'vscode',
	): Promise<RooTerminal> {
		// Phase 1: Always create new terminal (simplified logic)
		const terminal = this.createTerminal(cwd, provider);
		terminal.taskId = taskId;
		return terminal;
	}

	/**
	 * Gets unretrieved output from a terminal process
	 *
	 * @param id - The terminal ID
	 * @returns The unretrieved output as a string, or empty string if terminal not found
	 */
	public static getUnretrievedOutput(id: number): string {
		const terminal = this.terminals.find((t) => t.id === id);
		return terminal?.getUnretrievedOutput() ?? '';
	}

	/**
	 * Checks if a terminal process is "hot" (recently active)
	 *
	 * @param id - The terminal ID
	 * @returns True if the process is hot, false otherwise
	 */
	public static isProcessHot(id: number): boolean {
		const terminal = this.terminals.find((t) => t.id === id);
		return terminal?.process?.isHot ?? false;
	}

	/**
	 * Gets terminals filtered by busy state and optionally by task id
	 *
	 * @param busy - Whether to get busy or non-busy terminals
	 * @param taskId - Optional task ID to filter terminals by
	 * @returns Array of terminal objects
	 */
	public static getTerminals(busy: boolean, taskId?: string): RooTerminal[] {
		return this.terminals.filter((t) => {
			if (t.busy !== busy) {
				return false;
			}

			if (taskId !== undefined && t.taskId !== taskId) {
				return false;
			}

			return true;
		});
	}

	/**
	 * Gets background terminals (taskId undefined) that have unretrieved output or are still running
	 *
	 * @param busy - Whether to get busy or non-busy terminals
	 * @returns Array of terminal objects
	 */
	public static getBackgroundTerminals(busy?: boolean): RooTerminal[] {
		return this.terminals.filter((t) => {
			if (t.taskId !== undefined) {
				return false;
			}

			if (busy === undefined) {
				return t.getProcessesWithOutput().length > 0 || t.process?.hasUnretrievedOutput();
			}

			return t.busy === busy;
		});
	}

	/**
	 * Releases all terminals associated with a task
	 *
	 * @param taskId - The task ID
	 */
	public static releaseTerminalsForTask(taskId: string): void {
		this.terminals.forEach((terminal) => {
			if (terminal.taskId === taskId) {
				terminal.taskId = undefined;
			}
		});
	}

	/**
	 * Cleanup method for extension deactivation
	 */
	public static cleanup(): void {
		// Phase 1: Simple cleanup
		this.terminals = [];
		console.log('[TerminalRegistry] Cleaned up');
	}
}

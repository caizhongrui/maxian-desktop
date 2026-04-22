/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/task/Task.ts
// Phase 2 Implementation - Core Task class with stub methods for complex functionality
// TODO: Full implementation requires ApiHandler, WebView integration, and tool execution

import * as crypto from 'crypto';

import {
	TokenUsage,
	ToolUsage,
	ToolName,
	ClineMessage,
	ClineSay,
	ClineAsk,
	CreateTaskOptions,
} from '../types/taskTypes.js';

import { ApiMessage, readApiMessages, saveApiMessages, readTaskMessages, saveTaskMessages, taskMetadata } from '../task-persistence/index.js';
import { AssistantMessageContent, AssistantMessageParser, presentAssistantMessage } from '../assistant-message/index.js';
import { FileContextTracker, type IStorageProvider } from '../context-tracking/FileContextTracker.js';
import { MaxianIgnoreController } from '../ignore/MaxianIgnoreController.js';
import { MaxianProtectedController } from '../protect/MaxianProtectedController.js';
import { checkpointSave, checkpointRestore, checkpointDiff } from '../checkpoints/index.js';
import type { RooTerminalProcess } from '../terminal/terminalTypes.js';
import type { IApiHandler, StreamChunk } from '../api/types.js';

/**
 * Task options for initialization
 */
export interface TaskOptions extends CreateTaskOptions {
	provider: IStorageProvider; // Provider with globalStorageUri (e.g., MaxianProvider)
	globalStoragePath: string;
	workspacePath?: string;
	apiConfiguration?: any; // Will be properly typed when ApiHandler is integrated
	enableDiff?: boolean;
	enableCheckpoints?: boolean;
	checkpointTimeout?: number;
	fuzzyMatchThreshold?: number;
	consecutiveMistakeLimit?: number;
	experiments?: Record<string, boolean>;
	startTask?: boolean;
	rootTask?: Task;
	parentTask?: Task;
	taskNumber?: number;
	onCreated?: (task: Task) => void;
}

/**
 * Ask response type
 */
export interface ClineAskResponse {
	response: 'yesButtonTapped' | 'noButtonTapped' | 'messageResponse';
	text?: string;
	images?: string[];
}

/**
 * Main Task class - manages the lifecycle and execution of an AI assistant task
 *
 * NOTE: Phase 2 stub implementation
 * This is a minimal implementation with core structure and stub methods.
 * Full implementation requires:
 * - ApiHandler integration for LLM calls
 * - WebView/Provider integration for UI communication
 * - Tool execution system
 * - Event handling
 * - Terminal integration
 * - Diff/editing capabilities
 */
export class Task {
	// === Core Properties ===
	readonly taskId: string;
	readonly rootTaskId?: string;
	readonly parentTaskId?: string;
	childTaskId?: string;

	readonly instanceId: string;
	readonly taskNumber: number;
	readonly workspacePath: string;
	private readonly globalStoragePath: string;
	private readonly provider: IStorageProvider;
	private readonly providerRef: WeakRef<IStorageProvider>;

	readonly rootTask: Task | undefined;
	readonly parentTask: Task | undefined;

	// === Task State ===
	abort: boolean = false;
	abandoned: boolean = false;
	isInitialized: boolean = false;
	isPaused: boolean = false;

	// === API Configuration ===
	readonly apiConfiguration: any;
	api?: IApiHandler; // Real API handler

	// === Controllers ===
	maxianIgnoreController?: MaxianIgnoreController;
	maxianProtectedController?: MaxianProtectedController;
	fileContextTracker: FileContextTracker;

	// === Terminal ===
	terminalProcess?: RooTerminalProcess;

	// === Editing ===
	diffEnabled: boolean = false;
	fuzzyMatchThreshold: number;
	didEditFile: boolean = false;

	// === Messages ===
	apiConversationHistory: ApiMessage[] = [];
	clineMessages: ClineMessage[] = [];

	// === Ask State ===
	private askResponse?: 'yesButtonTapped' | 'noButtonTapped' | 'messageResponse';
	private askResponseText?: string;
	private askResponseImages?: string[];
	public lastMessageTs?: number;

	// === Tool State ===
	consecutiveMistakeCount: number = 0;
	consecutiveMistakeLimit: number;
	toolUsage: ToolUsage = {};

	// === Checkpoints ===
	enableCheckpoints: boolean;
	checkpointTimeout: number;
	checkpointService?: any;
	checkpointServiceInitializing: boolean = false;

	// === Streaming ===
	isWaitingForFirstChunk: boolean = false;
	isStreaming: boolean = false;
	currentStreamingContentIndex: number = 0;
	currentStreamingDidCheckpoint: boolean = false;
	assistantMessageContent: AssistantMessageContent[] = [];
	presentAssistantMessageLocked: boolean = false;
	presentAssistantMessageHasPendingUpdates: boolean = false;
	userMessageContent: any[] = [];
	userMessageContentReady: boolean = false;
	didRejectTool: boolean = false;
	didAlreadyUseTool: boolean = false;
	didCompleteReadingStream: boolean = false;
	assistantMessageParser: AssistantMessageParser;

	constructor({
		provider,
		globalStoragePath,
		workspacePath,
		apiConfiguration,
		enableDiff = false,
		enableCheckpoints = true,
		checkpointTimeout = 30,
		fuzzyMatchThreshold = 1.0,
		consecutiveMistakeLimit = 3,
		task,
		images,
		historyItem,
		rootTask,
		parentTask,
		taskNumber = 1,
		onCreated,
	}: TaskOptions) {
		this.provider = provider;
		this.providerRef = new WeakRef(provider);
		this.globalStoragePath = globalStoragePath;
		this.workspacePath = workspacePath || process.cwd();
		this.apiConfiguration = apiConfiguration;
		this.diffEnabled = enableDiff;
		this.enableCheckpoints = enableCheckpoints;
		this.checkpointTimeout = checkpointTimeout;
		this.fuzzyMatchThreshold = fuzzyMatchThreshold;
		this.consecutiveMistakeLimit = consecutiveMistakeLimit;

		// Initialize IDs
		if (historyItem) {
			this.taskId = historyItem.taskId;
			this.rootTaskId = historyItem.id !== historyItem.taskId ? historyItem.id : undefined;
			this.parentTaskId = historyItem.taskId;
		} else {
			this.taskId = crypto.randomBytes(8).toString('hex');
			this.rootTaskId = rootTask?.taskId;
			this.parentTaskId = parentTask?.taskId;
		}

		this.instanceId = crypto.randomBytes(4).toString('hex');
		this.taskNumber = taskNumber;

		// Set up task hierarchy
		this.rootTask = rootTask;
		this.parentTask = parentTask;

		// Initialize controllers and trackers
		this.fileContextTracker = new FileContextTracker(this.provider, this.taskId);

		// Initialize AssistantMessageParser
		this.assistantMessageParser = new AssistantMessageParser();

		// Call onCreate callback
		if (onCreated) {
			onCreated(this);
		}

		console.log(`[Task] Created task ${this.taskId} (instance: ${this.instanceId})`);
	}

	/**
	 * Static factory method to create and start a task
	 */
	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false });
		const { images, task, historyItem } = options;
		let promise: Promise<void>;

		if (images || task) {
			promise = instance.startTask(task, images);
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory();
		} else {
			throw new Error('Either historyItem or task/images must be provided');
		}

		return [instance, promise];
	}

	// ========================================
	// API Message Management
	// ========================================

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath });
	}

	public async addToApiConversationHistory(message: any): Promise<void> {
		const messageWithTs = { ...message, ts: Date.now() };
		this.apiConversationHistory.push(messageWithTs);
		await this.saveApiConversationHistory();
	}

	async overwriteApiConversationHistory(newHistory: ApiMessage[]): Promise<void> {
		this.apiConversationHistory = newHistory;
		await this.saveApiConversationHistory();
	}

	private async saveApiConversationHistory(): Promise<void> {
		try {
			await saveApiMessages({
				messages: this.apiConversationHistory,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			});
		} catch (error) {
			console.error('Failed to save API conversation history:', error);
		}
	}

	// ========================================
	// Cline Message Management
	// ========================================

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath });
	}

	private async addToClineMessages(message: ClineMessage): Promise<void> {
		this.clineMessages.push(message);
		await this.saveClineMessages();
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]): Promise<void> {
		this.clineMessages = newMessages;
		await this.saveClineMessages();
	}

	private async saveClineMessages(): Promise<void> {
		try {
			await saveTaskMessages({
				messages: this.clineMessages,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			});
		} catch (error) {
			console.error('Failed to save Cline messages:', error);
		}
	}

	/**
	 * Update a message in the WebView
	 * Phase 2: Stub - Full implementation requires WebView integration
	 */
	private async updateClineMessage(message: ClineMessage): Promise<void> {
		const provider = this.providerRef.deref();
		if (provider) {
			// TODO: provider.postMessageToWebview({ type: 'messageUpdated', clineMessage: message });
			console.log(`[Task#updateClineMessage] Updated message (WebView stub): ${(message as any).type}`);
		}
	}

	public findMessageByTimestamp(ts: number): ClineMessage | undefined {
		return this.clineMessages.find((m) => (m as any).ts === ts);
	}

	async nextClineMessageTimestamp(): Promise<number> {
		const lastMessage = this.clineMessages[this.clineMessages.length - 1];
		const lastTs = (lastMessage as any)?.ts ?? Date.now();
		return lastTs + 1;
	}

	// ========================================
	// Core Task Methods - STUBS
	// ========================================

	/**
	 * Ask the user a question and wait for response
	 * Complete implementation based on Kilocode's ask method
	 */
	async ask(
		type: ClineAsk,
		question?: string,
		partial?: boolean,
		progressStatus?: any,
		isProtected?: boolean,
		extra?: Partial<ClineMessage>,
	): Promise<ClineAskResponse> {
		if (this.abort) {
			throw new Error(`[Task#ask] task ${this.taskId}.${this.instanceId} aborted`);
		}

		let askTs: number;

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1);

			const isUpdatingPreviousPartial =
				lastMessage && (lastMessage as any).partial && lastMessage.type === 'ask' && lastMessage.ask === type;

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					(lastMessage as any).text = question;
					(lastMessage as any).partial = partial;
					(lastMessage as any).progressStatus = progressStatus;
					(lastMessage as any).isProtected = isProtected;
					this.updateClineMessage(lastMessage);
					throw new Error('Current ask promise was ignored (#1)');
				} else {
					// This is a new partial message, so add it with partial state.
					askTs = await this.nextClineMessageTimestamp();
					this.lastMessageTs = askTs;
					await this.addToClineMessages({
						ts: askTs as any,
						type: 'ask',
						ask: type,
						text: question,
						partial,
						isProtected,
						...(extra || {}),
					} as any);
					throw new Error('Current ask promise was ignored (#2)');
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial message.
					this.askResponse = undefined;
					this.askResponseText = undefined;
					this.askResponseImages = undefined;

					askTs = (lastMessage as any).ts;
					this.lastMessageTs = askTs;
					(lastMessage as any).text = question;
					(lastMessage as any).partial = false;
					(lastMessage as any).progressStatus = progressStatus;
					(lastMessage as any).isProtected = isProtected;
					await this.saveClineMessages();
					this.updateClineMessage(lastMessage);
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined;
					this.askResponseText = undefined;
					this.askResponseImages = undefined;
					askTs = await this.nextClineMessageTimestamp();
					this.lastMessageTs = askTs;
					await this.addToClineMessages({
						ts: askTs as any,
						type: 'ask',
						ask: type,
						text: question,
						isProtected,
						...(extra || {}),
					} as any);
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined;
			this.askResponseText = undefined;
			this.askResponseImages = undefined;
			askTs = await this.nextClineMessageTimestamp();
			this.lastMessageTs = askTs;
			await this.addToClineMessages({
				ts: askTs as any,
				type: 'ask',
				ask: type,
				text: question,
				isProtected,
				...(extra || {}),
			} as any);
		}

		// Wait for askResponse to be set (with 100ms polling interval)
		// Phase 2: Simplified waiting - no pWaitFor library, use simple polling
		await this.waitForAskResponse(askTs);

		// Return the response
		const result = {
			response: this.askResponse!,
			text: this.askResponseText,
			images: this.askResponseImages,
		};

		this.askResponse = undefined;
		this.askResponseText = undefined;
		this.askResponseImages = undefined;

		return result;
	}

	/**
	 * Wait for ask response with polling
	 */
	private async waitForAskResponse(askTs: number): Promise<void> {
		const interval = 100; // 100ms polling interval
		const maxWait = 1000 * 60 * 60; // 1 hour max wait time
		const startTime = Date.now();

		while (this.askResponse === undefined && this.lastMessageTs === askTs) {
			if (Date.now() - startTime > maxWait) {
				throw new Error('Ask response timeout after 1 hour');
			}

			// Check if task was aborted
			if (this.abort) {
				throw new Error(`[Task#waitForAskResponse] task ${this.taskId}.${this.instanceId} aborted`);
			}

			// Wait for interval
			await new Promise((resolve) => setTimeout(resolve, interval));
		}
	}

	/**
	 * Say something to the user (send a message)
	 * Complete implementation based on Kilocode's say method
	 */
	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		extra?: any,
		sayTs?: number,
		options?: { isNonInteractive?: boolean },
	): Promise<void> {
		if (this.abort) {
			throw new Error(`[Task#say] task ${this.taskId}.${this.instanceId} aborted`);
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1);

			const isUpdatingPreviousPartial =
				lastMessage && (lastMessage as any).partial && lastMessage.type === 'say' && lastMessage.say === type;

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					(lastMessage as any).text = text;
					(lastMessage as any).images = images;
					(lastMessage as any).partial = partial;
					this.updateClineMessage(lastMessage);
				} else {
					// This is a new partial message, so add it with partial state.
					const ts = await this.nextClineMessageTimestamp();

					if (!options?.isNonInteractive) {
						this.lastMessageTs = ts;
					}

					await this.addToClineMessages({
						ts: ts as any,
						type: 'say',
						say: type,
						text,
						images,
						partial,
						...(extra || {}),
					} as any);
				}
			} else {
				// Now have a complete version of a previously partial message.
				if (isUpdatingPreviousPartial) {
					if (!options?.isNonInteractive) {
						this.lastMessageTs = (lastMessage as any).ts;
					}

					(lastMessage as any).text = text;
					(lastMessage as any).images = images;
					(lastMessage as any).partial = false;

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages();

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage);
				} else {
					// This is a new and complete message, so add it like normal.
					const ts = await this.nextClineMessageTimestamp();

					if (!options?.isNonInteractive) {
						this.lastMessageTs = ts;
					}

					await this.addToClineMessages({
						ts: ts as any,
						type: 'say',
						say: type,
						text,
						images,
						...(extra || {}),
					} as any);
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const ts = await this.nextClineMessageTimestamp();

			// A "non-interactive" message is a message that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options?.isNonInteractive) {
				this.lastMessageTs = ts;
			}

			await this.addToClineMessages({
				ts: ts as any,
				type: 'say',
				say: type,
				text,
				images,
				...(extra || {}),
			} as any);
		}
	}

	/**
	 * Start a new task
	 * Complete implementation based on Kilocode's startTask method
	 */
	private async startTask(task?: string, images?: string[]): Promise<void> {
		// Clear any previous conversation history
		this.clineMessages = [];
		this.apiConversationHistory = [];

		// Post state to WebView (Phase 2: stub for now)
		const provider = this.providerRef.deref();
		if (provider) {
			// TODO: provider.postStateToWebview();
		}

		// Add initial task message
		if (task) {
			await this.say('task', task, images);
		}

		this.isInitialized = true;

		// Prepare user content for API request
		const userContent: any[] = [
			{
				type: 'text',
				text: `<task>\n${task || 'No task specified'}\n</task>`,
			},
		];

		// Add image blocks if present
		if (images && images.length > 0) {
			for (const image of images) {
				userContent.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: 'image/png',
						data: image,
					},
				});
			}
		}

		// Start the main task loop
		await this.initiateTaskLoop(userContent);
	}

	/**
	 * Resume a task from history
	 * Complete implementation based on Kilocode's resumeTaskFromHistory method
	 */
	private async resumeTaskFromHistory(): Promise<void> {
		// Load saved messages from disk
		let modifiedClineMessages = await this.getSavedClineMessages();
		this.apiConversationHistory = await this.getSavedApiConversationHistory();

		// Remove any resume messages that may have been added before
		const lastRelevantMessageIndex = this.findLastRelevantMessageIndex(modifiedClineMessages);
		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages = modifiedClineMessages.slice(0, lastRelevantMessageIndex + 1);
		}

		// Remove any trailing reasoning-only messages
		while (modifiedClineMessages.length > 0) {
			const last = modifiedClineMessages[modifiedClineMessages.length - 1];
			if (last.type === 'say' && last.say === 'reasoning') {
				modifiedClineMessages.pop();
			} else {
				break;
			}
		}

		// Update clineMessages
		this.clineMessages = modifiedClineMessages;
		this.isInitialized = true;

		// Check if task was completed
		const lastMessage = this.clineMessages[this.clineMessages.length - 1];
		const isCompleted = lastMessage?.type === 'say' && lastMessage.say === 'completion_result';

		// Ask user if they want to resume
		const { response, text, images } = await this.ask(
			isCompleted ? 'resume_completed_task' : 'resume_task',
			undefined,
		);

		if (response === 'messageResponse') {
			// User wants to resume with a new message
			const userContent: any[] = [
				{
					type: 'text',
					text: text || 'Continue',
				},
			];

			// Add image blocks if present
			if (images && images.length > 0) {
				for (const image of images) {
					userContent.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: 'image/png',
							data: image,
						},
					});
				}
			}

			await this.say('user_feedback', text, images);

			// Continue the task loop
			await this.initiateTaskLoop(userContent);
		}
		// If response is 'noButtonTapped', task remains paused
	}

	/**
	 * Find the last relevant message index (excluding resume messages)
	 */
	private findLastRelevantMessageIndex(messages: ClineMessage[]): number {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.type === 'ask' && (msg.ask === 'resume_task' || msg.ask === 'resume_completed_task')) {
				continue;
			}
			return i;
		}
		return -1;
	}

	/**
	 * Initiate the main task loop
	 * Calls the main recursive request loop
	 */
	private async initiateTaskLoop(userContent: any[]): Promise<void> {
		console.log('[Task#initiateTaskLoop] Starting task loop');
		console.log('[Task#initiateTaskLoop] User content:', JSON.stringify(userContent).substring(0, 200));

		// Start the main recursive loop
		await this.recursivelyMakeClineRequests(userContent, true);
	}

	/**
	 * Main recursive loop for making API requests and processing responses
	 * Phase 2: Simplified but functional implementation
	 *
	 * This is the core task execution loop that:
	 * 1. Sends user content to the API
	 * 2. Receives and processes streaming responses
	 * 3. Executes tools as requested
	 * 4. Loops until task completion
	 *
	 * @param userContent - User message content to send to API
	 * @param includeFileDetails - Whether to include file context details
	 * @returns True if loop ended normally, false if aborted
	 */
	public async recursivelyMakeClineRequests(
		userContent: any[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		// Stack-based iteration to avoid deep recursion
		interface StackItem {
			userContent: any[];
			includeFileDetails: boolean;
			retryAttempt?: number;
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }];

		while (stack.length > 0) {
			const currentItem = stack.pop()!;
			const currentUserContent = currentItem.userContent;

			if (this.abort) {
				throw new Error(
					`[Task#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`,
				);
			}

			// Check consecutive mistake limit
			if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
				const { response, text, images } = await this.ask(
					'mistake_limit_reached',
					'The assistant has made several consecutive mistakes. Would you like to continue?',
				);

				if (response === 'messageResponse') {
					// User provided feedback, add to content and reset counter
					currentUserContent.push({
						type: 'text',
						text: text || 'Please continue',
					});

					if (images && images.length > 0) {
						for (const image of images) {
							currentUserContent.push({
								type: 'image',
								source: {
									type: 'base64',
									media_type: 'image/png',
									data: image,
								},
							});
						}
					}

					await this.say('user_feedback', text, images);
				}

				this.consecutiveMistakeCount = 0;
			}

			// Send api_req_started message
			await this.say('api_req_started', JSON.stringify({ apiProtocol: 'qwen' }), undefined, false, {}, undefined, {
				isNonInteractive: true,
			});

			// Add user content to conversation history
			await this.addToApiConversationHistory({ role: 'user', content: currentUserContent });

			try {
				// Reset streaming state for each new API request
				this.currentStreamingContentIndex = 0;
				this.assistantMessageContent = [];
				this.didCompleteReadingStream = false;
				this.userMessageContent = [];
				this.userMessageContentReady = false;
				this.didRejectTool = false;
				this.didAlreadyUseTool = false;
				this.presentAssistantMessageLocked = false;
				this.presentAssistantMessageHasPendingUpdates = false;
				this.assistantMessageParser.reset();

				// Get streaming response from API
				const stream = this.attemptApiRequest();
				let assistantMessage = '';
				this.isStreaming = true;

				// Process streaming chunks
				const iterator = stream[Symbol.asyncIterator]();
				let item = await iterator.next();
				while (!item.done) {
					const chunk = item.value;
					item = await iterator.next();

					if (!chunk) {
						// Sometimes chunk is undefined
						continue;
					}

					switch (chunk.type) {
						case 'usage': {
							// TODO: Update token usage statistics
							console.log(`[Task] Usage: ${chunk.inputTokens} in, ${chunk.outputTokens} out`);
							break;
						}

						case 'text': {
							assistantMessage += chunk.text;

							// Parse raw assistant message chunk into content blocks
							const prevLength = this.assistantMessageContent.length;
							this.assistantMessageContent = this.assistantMessageParser.processChunk(chunk.text);

							if (this.assistantMessageContent.length > prevLength) {
								// New content block added, reset ready state
								this.userMessageContentReady = false;
							}

							// Present content to user
							await presentAssistantMessage(this);
							break;
						}

						case 'tool_use': {
							// Tool use from native format (not Anthropic XML)
							// This shouldn't happen with QwenHandler, but handle it anyway
							console.warn('[Task] Received tool_use chunk (unexpected for Qwen):', chunk);
							break;
						}

						case 'error': {
							throw new Error(chunk.error);
						}
					}

					// Check abort flag
					if (this.abort) {
						this.isStreaming = false;
						throw new Error(`[Task#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`);
					}

					// Check if tool was rejected
					if (this.didRejectTool) {
						assistantMessage += '\n\n[Response interrupted by user feedback]';
						break;
					}

					// Check if tool was already used
					if (this.didAlreadyUseTool) {
						assistantMessage += '\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]';
						break;
					}
				}

				// Stream complete
				this.didCompleteReadingStream = true;
				this.isStreaming = false;

				// Set any remaining partial blocks to complete
				const partialBlocks = this.assistantMessageContent.filter((block) => block.partial);
				partialBlocks.forEach((block) => (block.partial = false));

				// Finalize any remaining partial content blocks
				this.assistantMessageParser.finalizeContentBlocks();
				this.assistantMessageContent = this.assistantMessageParser.getContentBlocks();

				if (partialBlocks.length > 0) {
					// Present the last partial message that we just set to complete
					await presentAssistantMessage(this);
				}

				// Wait for user message content to be ready (presentAssistantMessage sets this)
				// Simple polling wait
				const maxWait = 30000; // 30 seconds
				const startTime = Date.now();
				while (!this.userMessageContentReady) {
					if (Date.now() - startTime > maxWait) {
						console.warn('[Task] Timeout waiting for userMessageContentReady');
						break;
					}
					if (this.abort) {
						throw new Error(`[Task#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`);
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}

				// Add assistant message to conversation history
				await this.addToApiConversationHistory({ role: 'assistant', content: this.assistantMessageContent });

				// Check if task is complete (attempt_completion tool was used)
				const hasCompletionTool = this.assistantMessageContent.some(
					(block: any) => block.type === 'tool_use' && block.name === 'attempt_completion',
				);

				if (hasCompletionTool) {
					await this.say('completion_result', 'Task completed!');
					return true; // End loop
				}

				// If there's user content ready (tool responses), push back onto stack to continue loop
				if (this.userMessageContentReady && this.userMessageContent.length > 0) {
					stack.push({
						userContent: this.userMessageContent,
						includeFileDetails: false,
						retryAttempt: 0,
					});

					// Reset user message state
					this.userMessageContent = [];
					this.userMessageContentReady = false;
				} else {
					// No tools used, ask if task is complete
					const { response, text, images } = await this.ask(
						'followup',
						'No tools were used. Is the task complete, or would you like to continue?',
					);

					if (response === 'messageResponse') {
						// User wants to continue with new instructions
						const userContent: any[] = [
							{
								type: 'text',
								text: text || 'Please continue',
							},
						];

						if (images && images.length > 0) {
							for (const image of images) {
								userContent.push({
									type: 'image',
									source: {
										type: 'base64',
										media_type: 'image/png',
										data: image,
									},
								});
							}
						}

						await this.say('user_feedback', text, images);

						stack.push({
							userContent,
							includeFileDetails: false,
							retryAttempt: 0,
						});

						this.consecutiveMistakeCount++;
					} else {
						// User chose not to continue
						return true;
					}
				}
			} catch (error) {
				this.isStreaming = false;
				console.error('[recursivelyMakeClineRequests] Error:', error);

				// Check if error is due to task abort - if so, don't show error message
				const errorMessage = (error as Error).message || '';
				if (this.abort || errorMessage.includes('aborted')) {
					// Task was aborted, silently stop without showing error
					throw error;
				}

				// Show error to user
				await this.say('error', `API request failed: ${errorMessage}`);

				// Error already handled by attemptApiRequest if it's a first-chunk error
				// For mid-stream errors, we need to ask the user
				if (!this.isWaitingForFirstChunk) {
					const { response } = await this.ask('api_req_failed', 'The API request failed mid-stream. Would you like to retry?');

					if (response === 'yesButtonTapped') {
						// Retry the same request
						stack.push(currentItem);
					} else {
						// User cancelled, end loop
						return false;
					}
				} else {
					// First chunk error already handled by attemptApiRequest
					// Just rethrow to abort
					throw error;
				}
			}
		}

		return true;
	}

	/**
	 * Attempt API request with retry logic
	 * Generator function that yields streaming chunks from the API
	 * Based on Kilocode's attemptApiRequest implementation
	 */
	private async *attemptApiRequest(retryAttempt: number = 0): AsyncGenerator<StreamChunk, void, unknown> {
		if (this.abort) {
			throw new Error(`[attemptApiRequest] task ${this.taskId}.${this.instanceId} aborted`);
		}

		// Initialize API handler if not already done
		if (!this.api) {
			// TODO: Create API handler from apiConfiguration
			// For now, assume it's already set by the provider
			throw new Error('[attemptApiRequest] API handler not initialized');
		}

		// Get system prompt (stub for now)
		const systemPrompt = '你是码弦（Maxian）AI助手。除非用户明确要求其他语言，否则所有自然语言输出必须使用简体中文；代码、命令、路径和标识符保持原文。';

		// Get clean conversation history (remove ts timestamps)
		const cleanConversationHistory = this.apiConversationHistory.map(({ role, content }) => ({
			role,
			content,
		}));

		// Create the streaming API request
		const stream = this.api.createMessage(systemPrompt, cleanConversationHistory as any, undefined);
		const iterator = stream[Symbol.asyncIterator]();

		try {
			// Await first chunk to see if it will throw an error
			this.isWaitingForFirstChunk = true;
			const firstChunk = await iterator.next();
			if (!firstChunk.done && firstChunk.value) {
				yield firstChunk.value;
			}
			this.isWaitingForFirstChunk = false;
		} catch (error) {
			this.isWaitingForFirstChunk = false;

			// First chunk failed - ask user if they want to retry
			const { response } = await this.ask(
				'api_req_failed',
				`API request failed: ${(error as Error).message}. Would you like to retry?`,
			);

			if (response !== 'yesButtonTapped') {
				throw new Error('API request failed');
			}

			await this.say('api_req_retried', 'Retrying API request...');

			// Retry with incremented attempt count
			yield* this.attemptApiRequest(retryAttempt + 1);
			return;
		}

		// No error on first chunk, yield all remaining chunks
		yield* iterator;
	}

	/**
	 * Abort the current task
	 */
	public async abortTask(isAbandoned: boolean = false): Promise<void> {
		console.log(`[Task#abortTask] Aborting task ${this.taskId}, abandoned: ${isAbandoned}`);

		this.abort = true;
		this.abandoned = isAbandoned;

		// TODO: Cancel API requests
		// TODO: Clean up resources
	}

	/**
	 * Dispose and clean up resources
	 */
	public dispose(): void {
		console.log(`[Task#dispose] Disposing task ${this.taskId}`);

		this.abort = true;

		// Clean up file context tracker
		this.fileContextTracker.dispose();

		// TODO: Clean up other resources
	}

	/**
	 * Record tool usage
	 */
	public recordToolUsage(toolName: ToolName): void {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = 0;
		}
		this.toolUsage[toolName]++;
	}

	/**
	 * Get current token usage
	 */
	public getTokenUsage(): TokenUsage {
		// TODO: Calculate from API messages
		return {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCost: 0,
			contextTokens: 0
		};
	}

	/**
	 * Checkpoint save - delegates to checkpoint module
	 */
	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false): Promise<void> {
		if (!this.enableCheckpoints) {
			return;
		}
		await checkpointSave(this, force, suppressMessage);
	}

	/**
	 * Checkpoint restore - delegates to checkpoint module
	 */
	public async checkpointRestore(options: any): Promise<void> {
		if (!this.enableCheckpoints) {
			return;
		}
		await checkpointRestore(this, options);
	}

	/**
	 * Checkpoint diff - delegates to checkpoint module
	 */
	public async checkpointDiff(options: any): Promise<void> {
		if (!this.enableCheckpoints) {
			return;
		}
		await checkpointDiff(this, options);
	}

	// ========================================
	// Utility Methods
	// ========================================

	/**
	 * Get task metadata for history
	 */
	public async getTaskMetadata(): Promise<any> {
		return taskMetadata({
			taskId: this.taskId,
			rootTaskId: this.rootTaskId,
			parentTaskId: this.parentTaskId,
			taskNumber: this.taskNumber,
			messages: this.clineMessages,
			globalStoragePath: this.globalStoragePath,
			workspace: this.workspacePath,
		});
	}

	/**
	 * Combine messages for processing
	 */
	public combineMessages(messages: ClineMessage[]): ClineMessage[] {
		// TODO: Implement message combining logic
		return messages;
	}

	// ========================================
	// Ask Response Handling
	// ========================================

	/**
	 * Handle WebView ask response
	 * This is called by the Provider when the user responds to an ask
	 */
	public handleWebviewAskResponse(
		askResponse: 'yesButtonTapped' | 'noButtonTapped' | 'messageResponse',
		text?: string,
		images?: string[],
	): void {
		// Store text and images first
		this.askResponseText = text;
		this.askResponseImages = images;

		// Set askResponse last to trigger waiting callbacks
		this.askResponse = askResponse;

		// Create a checkpoint whenever the user sends a message
		if (askResponse === 'messageResponse') {
			void this.checkpointSave(false, true);
		}
	}

	/**
	 * Approve an ask (yes button clicked)
	 */
	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}): void {
		this.handleWebviewAskResponse('yesButtonTapped', text, images);
	}

	/**
	 * Deny an ask (no button clicked)
	 */
	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}): void {
		this.handleWebviewAskResponse('noButtonTapped', text, images);
	}

	/**
	 * Send a message response to an ask
	 */
	public sendMessageResponse(text: string, images?: string[]): void {
		this.handleWebviewAskResponse('messageResponse', text, images);
	}
}

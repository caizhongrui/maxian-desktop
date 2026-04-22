/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied from Kilocode src/core/assistant-message/index.ts
// Complete implementation

export { type AssistantMessageContent, parseAssistantMessage } from './parseAssistantMessage.js';
export { AssistantMessageParser, type AnthropicToolUseBlockParam } from './AssistantMessageParser.js';
export { type NativeToolCall, parseDoubleEncodedParams, extractMcpToolInfo } from './NativeToolCall.js';
export { presentAssistantMessage } from './presentAssistantMessage.js';

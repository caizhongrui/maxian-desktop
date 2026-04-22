/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Cancellation Token
 *
 *  基于 VSCode 同构接口的简化实现，便于跨平台使用。
 *--------------------------------------------------------------------------------------------*/

export interface IDisposable {
	dispose(): void;
}

/** Event 类型：订阅/注销模式 */
export type Event<T> = (listener: (e: T) => void) => IDisposable;

/** 取消 Token 接口 */
export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: Event<unknown>;
}

/** 永不取消 */
export const CancellationToken = {
	None: {
		isCancellationRequested: false,
		onCancellationRequested: (_listener: (e: unknown) => void) => ({
			dispose: () => { /* noop */ },
		}),
	} satisfies CancellationToken,
};

/** 可取消的 Token 源 */
export class CancellationTokenSource {
	private _token?: MutableToken;
	private _parentListener?: IDisposable;

	constructor(parent?: CancellationToken) {
		if (parent && parent.isCancellationRequested) {
			this.cancel();
		} else if (parent) {
			this._parentListener = parent.onCancellationRequested(() => this.cancel());
		}
	}

	get token(): CancellationToken {
		if (!this._token) {
			this._token = new MutableToken();
		}
		return this._token;
	}

	cancel(): void {
		if (!this._token) {
			this._token = new MutableToken();
		}
		this._token.cancel();
	}

	dispose(cancel: boolean = false): void {
		if (cancel) {
			this.cancel();
		}
		this._parentListener?.dispose();
		if (this._token instanceof MutableToken) {
			this._token.dispose();
		}
	}
}

/**
 * Event Emitter — 对齐 VSCode 的 Emitter 类接口，以便直接复用消费方写法。
 */
export class Emitter<T> {
	private _listeners = new Set<(e: T) => void>();
	private _event: Event<T> | null = null;

	get event(): Event<T> {
		if (!this._event) {
			this._event = (listener: (e: T) => void) => {
				this._listeners.add(listener);
				return {
					dispose: () => {
						this._listeners.delete(listener);
					},
				};
			};
		}
		return this._event;
	}

	fire(event: T): void {
		for (const listener of Array.from(this._listeners)) {
			try {
				listener(event);
			} catch {
				// swallow
			}
		}
	}

	hasListeners(): boolean {
		return this._listeners.size > 0;
	}

	dispose(): void {
		this._listeners.clear();
	}
}

class MutableToken implements CancellationToken {
	private _isCancelled = false;
	private _listeners = new Set<(e: unknown) => void>();

	get isCancellationRequested(): boolean {
		return this._isCancelled;
	}

	readonly onCancellationRequested: Event<unknown> = (listener) => {
		if (this._isCancelled) {
			listener(undefined);
			return { dispose: () => { /* noop */ } };
		}
		this._listeners.add(listener);
		return {
			dispose: () => { this._listeners.delete(listener); },
		};
	};

	cancel(): void {
		if (this._isCancelled) {
			return;
		}
		this._isCancelled = true;
		for (const listener of this._listeners) {
			try {
				listener(undefined);
			} catch {
				// swallow
			}
		}
		this._listeners.clear();
	}

	dispose(): void {
		this._listeners.clear();
	}
}

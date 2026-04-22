/*---------------------------------------------------------------------------------------------
 *  Maxian Core — Lifecycle / Disposable
 *
 *  对齐 VSCode 的 Disposable 基类，以便直接复用消费方写法。
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from './cancellation.js';

export type { IDisposable };

/**
 * 可销毁对象基类。
 * 子类通过 `this._register(disposable)` 注册需要跟随生命周期一起销毁的资源。
 */
export class Disposable implements IDisposable {
	private _store: IDisposable[] = [];
	private _isDisposed = false;

	protected _register<T extends IDisposable>(disposable: T): T {
		if (this._isDisposed) {
			try {
				disposable.dispose();
			} catch { /* noop */ }
			return disposable;
		}
		this._store.push(disposable);
		return disposable;
	}

	get isDisposed(): boolean {
		return this._isDisposed;
	}

	dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		for (const d of this._store) {
			try {
				d.dispose();
			} catch { /* swallow */ }
		}
		this._store.length = 0;
	}
}

/**
 * 可销毁对象集合。
 */
export class DisposableStore implements IDisposable {
	private _store: IDisposable[] = [];
	private _isDisposed = false;

	add<T extends IDisposable>(d: T): T {
		if (this._isDisposed) {
			try { d.dispose(); } catch { /* noop */ }
			return d;
		}
		this._store.push(d);
		return d;
	}

	clear(): void {
		for (const d of this._store) {
			try { d.dispose(); } catch { /* swallow */ }
		}
		this._store.length = 0;
	}

	dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		this.clear();
	}
}

/** 组合多个 disposable 为单个。 */
export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
	return {
		dispose: () => {
			for (const d of disposables) {
				try { d.dispose(); } catch { /* swallow */ }
			}
		},
	};
}

/** 空操作 disposable。 */
export const EmptyDisposable: IDisposable = { dispose: () => { /* noop */ } };

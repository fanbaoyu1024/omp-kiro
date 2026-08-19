import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
} from "@oh-my-pi/pi-ai";

type StreamWaiter = {
	resolve: (value: IteratorResult<AssistantMessageEvent>) => void;
	reject: (error: unknown) => void;
};

/**
 * Minimal structural implementation of OMP's assistant event stream contract.
 * Keeping it local makes Git/marketplace installs self-contained: those installs
 * do not install the package's development-only OMP dependencies.
 */
class LocalAssistantMessageEventStream
	implements AsyncIterable<AssistantMessageEvent>
{
	readonly #queue: AssistantMessageEvent[] = [];
	readonly #waiting: StreamWaiter[] = [];
	readonly #finalResult: Promise<AssistantMessage>;
	readonly #resolveFinalResult: (message: AssistantMessage) => void;
	readonly #rejectFinalResult: (error: unknown) => void;
	#done = false;
	#failed = false;
	#error: unknown;
	#resultSettled = false;
	#pendingLocalWork = 0;

	constructor() {
		const result = Promise.withResolvers<AssistantMessage>();
		this.#finalResult = result.promise;
		this.#resolveFinalResult = result.resolve;
		this.#rejectFinalResult = result.reject;
		this.#finalResult.catch(() => {});
	}

	push(event: AssistantMessageEvent): void {
		if (this.#done) return;
		if (event.type === "done" || event.type === "error") {
			this.#done = true;
			this.#resultSettled = true;
			this.#resolveFinalResult(
				event.type === "done" ? event.message : event.error,
			);
		}
		this.#deliver(event);
	}

	end(result?: AssistantMessage): void {
		this.#done = true;
		if (result !== undefined && !this.#resultSettled) {
			this.#resultSettled = true;
			this.#resolveFinalResult(result);
		} else if (!this.#resultSettled) {
			this.#resultSettled = true;
			this.#rejectFinalResult(new Error("Stream ended without a final result"));
		}
		this.#finishWaiting();
	}

	fail(error: unknown): void {
		if (this.#done) return;
		this.#done = true;
		this.#failed = true;
		this.#error = error;
		this.#resultSettled = true;
		this.#rejectFinalResult(error);
		while (this.#waiting.length > 0) this.#waiting.shift()!.reject(error);
	}

	result(): Promise<AssistantMessage> {
		return this.#finalResult;
	}

	get hasPendingLocalWork(): boolean {
		return this.#pendingLocalWork > 0;
	}

	async trackLocalWork<T>(work: Promise<T>): Promise<T> {
		this.#pendingLocalWork += 1;
		try {
			return await work;
		} finally {
			this.#pendingLocalWork -= 1;
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		while (true) {
			const queued = this.#queue.shift();
			if (queued !== undefined) {
				yield queued;
				continue;
			}
			if (this.#failed) throw this.#error;
			if (this.#done) return;
			const next = await new Promise<IteratorResult<AssistantMessageEvent>>(
				(resolve, reject) => {
					this.#waiting.push({ resolve, reject });
				},
			);
			if (next.done) return;
			yield next.value;
		}
	}

	#deliver(event: AssistantMessageEvent): void {
		const waiter = this.#waiting.shift();
		if (waiter) waiter.resolve({ value: event, done: false });
		else this.#queue.push(event);
	}

	#finishWaiting(): void {
		while (this.#waiting.length > 0) {
			this.#waiting.shift()!.resolve({ value: undefined, done: true });
		}
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;
}

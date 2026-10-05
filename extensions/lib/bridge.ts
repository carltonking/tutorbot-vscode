import { fstatSync } from "node:fs";
import { Socket } from "node:net";

// ────────────────────────────────────────────────────────────────────────────
// bridge — TutorBot's private link to the VS Code panel.
//
// The panel starts pi with an extra pipe on file descriptor 3 (and sets
// TUTORBOT_PANEL_FD=3). Over it, as JSON lines:
//   TutorBot → panel   {ev, data}           state, asks, file opens, squiggles
//                      {re, result}         reply to a panel request
//   panel → TutorBot   {id, api, body}      actions (submit, hint, answer, …)
//
// No ports and no files: only the process that started TutorBot can talk to it.
//
// pi re-creates extension instances on every session switch, so the bridge is
// a process-wide singleton (on globalThis) and API handlers are registered by
// name: the newest extension instance's handler always wins.
// ────────────────────────────────────────────────────────────────────────────

type ApiHandler = (body: any) => Promise<unknown> | unknown;

const MAX_LINE = 2_000_000;

function openPanelPipe(): Socket | undefined {
	const fd = Number(process.env.TUTORBOT_PANEL_FD);
	if (!Number.isInteger(fd) || fd < 3) return undefined;
	try {
		const st = fstatSync(fd);
		if (!st.isSocket() && !st.isFIFO()) return undefined;
		const sock = new Socket({ fd, readable: true, writable: true });
		sock.unref(); // stdin keeps pi alive; never this pipe
		return sock;
	} catch {
		return undefined;
	}
}

export class Bridge {
	private pipe?: Socket;
	private buf = "";
	private state: Record<string, unknown> = {};
	private handlers = new Map<string, ApiHandler>();
	private asks = new Map<string, { resolve: (v: any) => void; payload: unknown }>();
	private askSeq = 0;

	constructor() {
		this.pipe = openPanelPipe();
		if (!this.pipe) return;
		this.pipe.setEncoding("utf8");
		this.pipe.on("data", (chunk: string) => this.onData(chunk));
		this.pipe.on("error", () => this.closed());
		this.pipe.on("close", () => this.closed());
		this.onApi("answer", (body) => this.answer(body));
	}

	// Kept for callers that start the bridge on session start; the pipe is
	// opened once, when the bridge is first created.
	start(_vaultRoot?: string): Promise<void> {
		return Promise.resolve();
	}

	hasPanel(): boolean {
		return Boolean(this.pipe && !this.pipe.destroyed);
	}

	// ── interactive asks (panel UI) ──────────────────────────────────────────
	// A tool asks the learner through here: the panel renders the card and
	// sends back an "answer". Resolves with the answer, or null if cancelled.
	ask(kind: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		const id = `ask-${Date.now().toString(36)}-${(this.askSeq++).toString(36)}`;
		const full = { id, kind, ...payload };
		return new Promise((resolve) => {
			const finish = (v: any) => {
				if (!this.asks.has(id)) return;
				this.asks.delete(id);
				this.emit("askDone", { id });
				resolve(v);
			};
			this.asks.set(id, { resolve: finish, payload: full });
			signal?.addEventListener("abort", () => finish(null), { once: true });
			if (!this.hasPanel()) return finish(null);
			this.emit("ask", full);
		});
	}

	private answer(body: any): unknown {
		const pending = this.asks.get(body?.id);
		if (!pending) return { ok: false, error: "no such question (already answered?)" };
		pending.resolve(body.cancelled ? null : body.value);
		return { ok: true };
	}

	// ── state pushed to the panel ────────────────────────────────────────────

	// A session started (startup, switch, new chat): the panel reloads.
	reset(): void {
		this.emit("reset", { state: this.state });
	}

	// Named slots of shared state (e.g. "subject", "exercise").
	setState(key: string, value: unknown): void {
		this.state[key] = value;
		this.emit("state", { key, value });
	}

	getState<T>(key: string): T | undefined {
		return this.state[key] as T | undefined;
	}

	// One-off events (e.g. ask VS Code to open a file).
	emit(event: string, data: unknown): void {
		this.write({ ev: event, data });
	}

	onApi(name: string, handler: ApiHandler): void {
		this.handlers.set(name, handler);
	}

	// ── pipe ─────────────────────────────────────────────────────────────────

	private write(msg: unknown): void {
		if (this.hasPanel()) this.pipe!.write(`${JSON.stringify(msg)}\n`);
	}

	private closed(): void {
		this.pipe = undefined;
		for (const a of [...this.asks.values()]) a.resolve(null);
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		if (this.buf.length > MAX_LINE && !this.buf.includes("\n")) this.buf = "";
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).trim();
			this.buf = this.buf.slice(i + 1);
			if (line) void this.onRequest(line);
		}
	}

	private async onRequest(line: string): Promise<void> {
		let req: any;
		try {
			req = JSON.parse(line);
		} catch {
			return;
		}
		const handler = this.handlers.get(String(req?.api));
		let result: unknown;
		try {
			result = handler ? ((await handler(req.body ?? {})) ?? { ok: true }) : { error: "unknown action" };
		} catch (e: any) {
			result = { error: String(e?.message ?? e) };
		}
		if (req?.id !== undefined) this.write({ re: req.id, result });
	}
}

const KEY = "__tutorbotBridge";
export function getBridge(): Bridge {
	const g = globalThis as any;
	g[KEY] ??= new Bridge();
	return g[KEY];
}

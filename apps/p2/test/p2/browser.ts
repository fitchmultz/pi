import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { buildBrowserScript } from "../../src/hosts/bundles.ts";
import { poll } from "./helpers.ts";

export const chromium =
	process.env.CHROMIUM_BIN ?? (process.env.PREFIX ? `${process.env.PREFIX}/lib/chromium/chrome` : "/usr/bin/chromium");
/**
 * Whether the Chromium UI tests run. Off on Android unless `P2_BROWSER_TESTS=1`: Chromium's processes plus the test's p2
 * server and workers exceed Android's limit of 32 child processes, and its phantom process killer then kills processes
 * (also the p2 the tests run under). Elsewhere on where Chromium is installed; `P2_BROWSER_TESTS=0` turns them off.
 */
export const browserTests =
	process.env.P2_BROWSER_TESTS === "1" ||
	(process.env.P2_BROWSER_TESTS !== "0" && process.platform !== "android" && existsSync(chromium));
/** A frame as DevTools describes it (`Page.Frame`). */
type BrowserFrame = { id: string; parentId?: string; url: string; unreachableUrl?: string };
type FrameTree = { frame: BrowserFrame; childFrames?: FrameTree[] };
type TargetInfo = { targetId: string; type: string; url: string };
export class Browser {
	readonly process: ChildProcess;
	readonly profile: string;
	readonly socket: WebSocket;
	private id = 0;
	private loaded = new Set<string>();
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private constructor(process: ChildProcess, profile: string, socket: WebSocket) {
		this.process = process;
		this.profile = profile;
		this.socket = socket;
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as {
				id?: number;
				result?: unknown;
				error?: { message: string };
				method?: string;
				params?: { name?: string; loaderId?: string };
			};
			if (
				message.method === "Page.lifecycleEvent" &&
				message.params?.name === "DOMContentLoaded" &&
				message.params.loaderId
			)
				this.loaded.add(message.params.loaderId);
			if (!message.id) return;
			const request = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) request?.reject(new Error(message.error.message));
			else request?.resolve(message.result);
		});
	}
	static async start(flags: string[] = []): Promise<Browser> {
		const profile = mkdtempSync(join(tmpdir(), "p2-browser-"));
		const process = spawn(
			chromium,
			[
				...(globalThis.process.env.PREFIX ? [`--browser-subprocess-path=${chromium}`] : []),
				...(globalThis.process.platform === "darwin" ? ["--use-mock-keychain"] : []),
				"--headless=new",
				"--no-sandbox",
				"--no-zygote",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				...flags,
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		await poll(() => existsSync(join(profile, "DevToolsActivePort")), 20_000, "Chromium debugging port");
		const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
			type: string;
			webSocketDebuggerUrl: string;
		}[];
		// Google Chrome also lists its component extensions' background pages; drive the tab.
		const page = targets.find((target) => target.type === "page") ?? targets[0]!;
		const socket = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const browser = new Browser(process, profile, socket);
		await browser.call("Page.enable");
		await browser.call("Page.setLifecycleEventsEnabled", { enabled: true });
		return browser;
	}
	/** Sends a DevTools command to the page, or to an attached target's flat session (`evaluateInFrame`). */
	call(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
	/**
	 * Evaluates `expression` in the out-of-process frame whose URL contains `url`: an artifact preview has an opaque
	 * origin, so the page itself cannot reach into it.
	 */
	async evaluateInFrame<T>(url: string, expression: string): Promise<T> {
		const target = (await this.frameTargets()).find((info) => info.url.includes(url));
		if (!target) throw new Error(`No frame target for ${url}`);
		return this.inTarget(target.targetId, async (sessionId) => {
			const response = (await this.call(
				"Runtime.evaluate",
				{ expression, returnByValue: true, awaitPromise: true },
				sessionId,
			)) as { result: { value: T }; exceptionDetails?: unknown };
			if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
			return response.result.value;
		});
	}
	/**
	 * Frames in every process, main frame first. `Page.getFrameTree` omits out-of-process frames, including blocked
	 * frames' isolated error pages; each has its own target and frame tree.
	 */
	async frames(): Promise<BrowserFrame[]> {
		const frames: BrowserFrame[] = [];
		const add = ({ frame, childFrames = [] }: FrameTree): void => {
			frames.push(frame);
			for (const child of childFrames) add(child);
		};
		const tree = async (sessionId?: string) =>
			((await this.call("Page.getFrameTree", {}, sessionId)) as { frameTree: FrameTree }).frameTree;
		add(await tree());
		for (const target of await this.frameTargets()) add(await this.inTarget(target.targetId, tree));
		return frames;
	}
	/** The targets of frames that run outside the page's process. */
	private async frameTargets(): Promise<TargetInfo[]> {
		const { targetInfos } = (await this.call("Target.getTargets")) as { targetInfos: TargetInfo[] };
		return targetInfos.filter((info) => info.type === "iframe");
	}
	/** Runs `use` with a flat session attached to the target, then detaches it. */
	private async inTarget<T>(targetId: string, use: (sessionId: string) => Promise<T>): Promise<T> {
		const { sessionId } = (await this.call("Target.attachToTarget", { targetId, flatten: true })) as {
			sessionId: string;
		};
		try {
			return await use(sessionId);
		} finally {
			await this.call("Target.detachFromTarget", { sessionId }).catch(() => {});
		}
	}
	async evaluate<T>(expression: string): Promise<T> {
		const response = (await this.call("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		})) as { result: { value: T }; exceptionDetails?: unknown };
		if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
		return response.result.value;
	}
	wait(expression: string): Promise<void> {
		return poll(() => this.evaluate<boolean>(`Boolean(${expression})`), 30_000, expression);
	}
	async metrics(width: number, height: number): Promise<void> {
		await this.call("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			mobile: width < 700,
			deviceScaleFactor: 1,
		});
	}
	async open(url: string): Promise<void> {
		const result = (await this.call("Page.navigate", { url })) as { loaderId?: string; errorText?: string };
		if (result.errorText) throw new Error(result.errorText);
		if (result.loaderId) await poll(() => this.loaded.has(result.loaderId!), 30_000, "new document loaded");
	}
	/**
	 * Runs a browser-only component fixture (`test/fixtures/<name>`) in the open page, compiled like the web bundle
	 * (`buildBrowserScript`) and evaluated through the debugger, which the page's CSP does not restrict. The fixture
	 * renders with its own React; the page's styles apply.
	 */
	async loadFixture(name: string): Promise<void> {
		await this.evaluate(await buildBrowserScript(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));
	}
	async click(selector: string): Promise<void> {
		await this.wait(
			`(() => { const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;for(let p=e;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.width>0&&r.height>0&&e.contains(hit); })()`,
		);
		const point = await this.evaluate<{ x: number; y: number }>(
			`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		await this.clickPoint(point.x, point.y);
	}
	async clickPoint(x: number, y: number): Promise<void> {
		await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	}
	async close(): Promise<void> {
		await this.call("Browser.close").catch(() => {});
		this.socket.close();
		// Browser.close acknowledges before Chromium (or its Docker wrapper) finishes flushing the profile.
		const exited = () => this.process.exitCode !== null || this.process.signalCode !== null;
		try {
			await poll(exited, 5000, "Chromium shutdown");
		} catch {
			this.process.kill("SIGTERM");
			await poll(exited, 5000, "Chromium termination");
		}
		rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

// Sending never waits for the connection (plugins/chat/outbox.ts): with the page offline the composer stays, a sent
// message shows at once like any other, and it reaches the server exactly once when the page is back online; one whose
// answer was lost shows once in its conversation opened again, and one whose upload fails stays shown. And a
// conversation opened before shows at once on a page that starts without a connection (src/web/conversation-cache.ts).

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Host } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/**
 * The page's WebSockets, with a switch: `__goOffline()` closes them and fails every new one (the app keeps retrying),
 * `__offline = false` lets the next retry through. `__loseAnswerOf(text)` lets the next frame carrying `text` reach the
 * server, but the page hears nothing after it (the answer among it) and goes offline a second later; `__framesWith`
 * counts the frames sent with each such text.
 */
const SWITCH = `(() => {
	const Native = WebSocket;
	const sockets = new Set();
	const decoder = new TextDecoder();
	let lose;
	// A page can start offline (a cold start without a connection): set before it loads.
	window.__offline = sessionStorage.getItem("offline") === "1";
	window.__framesWith = {};
	window.__loseAnswerOf = (text) => {
		window.__framesWith[text] = 0;
		lose = text;
	};
	window.WebSocket = class extends Native {
		#deaf = false;
		#heard = new Map();
		constructor(url, protocols) {
			// Offline: a path the server refuses, which closes at once as an unreachable server does.
			super(window.__offline ? String(url).replace("/chord", "/offline") : url, protocols);
			sockets.add(this);
			this.addEventListener("close", () => sockets.delete(this));
		}
		// The page hears frames through its message listeners, which a deaf socket skips.
		addEventListener(type, listener, options) {
			if (type !== "message") return super.addEventListener(type, listener, options);
			const heard = (event) => {
				if (!this.#deaf) listener.call(this, event);
			};
			this.#heard.set(listener, heard);
			return super.addEventListener(type, heard, options);
		}
		removeEventListener(type, listener, options) {
			const heard = type === "message" ? this.#heard.get(listener) : undefined;
			return super.removeEventListener(type, heard ?? listener, options);
		}
		send(data) {
			super.send(data);
			const texts = Object.keys(window.__framesWith);
			if (!texts.length) return;
			const frame = typeof data === "string" ? data : decoder.decode(data);
			for (const text of texts) if (frame.includes(text)) window.__framesWith[text]++;
			if (lose === undefined || !frame.includes(lose)) return;
			lose = undefined;
			this.#deaf = true;
			setTimeout(() => window.__goOffline(), 1000);
		}
	};
	window.__goOffline = () => {
		window.__offline = true;
		for (const socket of sockets) socket.close();
	};
})()`;
const draft = (text: string) =>
	`(()=>{const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
/** How many people's messages show `text`. */
const bubbles = (text: string) =>
	`[...document.querySelectorAll('.messages .user .bubble')].filter((e) => e.textContent.includes(${JSON.stringify(text)})).length`;
const inputs = (view: ConversationView | null | undefined, text: string) =>
	(view?.entries ?? []).filter((entry) => entry.kind === "p2.input" && JSON.stringify(entry.data).includes(text))
		.length;
/** The sidebar's row of the session titled `title`. */
const row = (title: string) =>
	`[...document.querySelectorAll('.drawer .session-main')].find((e) => e.querySelector('.session-title')?.textContent === ${JSON.stringify(title)})`;

describe("offline in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: SWITCH });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("keeps the composer, shows the message at once, and delivers it once back online", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Offline",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);

			await browser.evaluate("window.__goOffline()");
			await browser.wait(`Boolean(document.querySelector('.offline'))`);
			// The composer stays (no "Connecting…" bar): the page still knows it is the owner.
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`));
			const text = "hello while offline";
			await browser.evaluate(draft(text));
			await browser.click("button[aria-label=Send]");
			// It leaves the composer and shows at once, as any message does; the server does not have it yet.
			await browser.wait(`document.querySelector('.composer textarea').value === '' && ${bubbles(text)} === 1`);
			assert.equal(inputs(chat.view.value, text), 0);

			await browser.evaluate("window.__offline = false");
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 60_000);
			await browser.wait(`!document.querySelector('.offline') && ${bubbles(text)} === 1`);
			assert.equal(inputs(chat.view.value, text), 1, "delivered once");
			assert.equal(await browser.evaluate<number>(bubbles(text)), 1, "shown once");
		} finally {
			stop();
			chat.release();
		}
	});

	it("lets messages that arrived while offline fade in one after another, and nothing when opening", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Arrivals",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await chat.send({ text: "first", requestId: "a1" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: first"), 30_000);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			// Every row the transcript adds, with whether it arrives (animates) and its delay.
			await browser.evaluate(`(() => {
				window.__added = [];
				const record = (row) => window.__added.push({ text: row.textContent.trim().slice(0, 40), arriving: row.classList.contains("arriving"), delay: row.style.animationDelay });
				window.__glides = 0;
				new MutationObserver((changes) => {
					for (const change of changes) for (const node of change.addedNodes) if (node.classList?.contains("row")) record(node);
					// The transcript glides up to make room instead of jumping (a transform animation on .messages).
					const glide = document.querySelector(".messages")?.getAnimations().some((animation) => animation.effect?.getKeyframes().some((frame) => String(frame.transform).includes("translateY")));
					if (glide) window.__glides++;
				}).observe(document.body, { childList: true, subtree: true });
				for (const row of document.querySelectorAll(".row")) record(row);
			})()`);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: first')`);
			assert.deepEqual(
				await browser.evaluate<unknown[]>("window.__added.filter((row) => row.arriving)"),
				[],
				"opening animates nothing",
			);
			assert.equal(await browser.evaluate<number>("window.__glides"), 0, "opening glides nothing");
			// Offline while two more turns happen elsewhere.
			await browser.evaluate("window.__goOffline()");
			await browser.wait(`Boolean(document.querySelector('.offline'))`);
			for (const text of ["second", "third"]) {
				await chat.send({ text, requestId: text }, BACKGROUND_CONTEXT);
				await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 30_000);
			}
			await browser.evaluate("window.__offline = false");
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: third')`);
			const arrived = await browser.evaluate<{ text: string; arriving: boolean; delay: string }[]>(
				"window.__added.filter((row) => row.arriving)",
			);
			for (const text of ["second", "Echo: second", "third", "Echo: third"])
				assert.ok(
					arrived.some((row) => row.text.includes(text)),
					`${text} arrived: ${JSON.stringify(arrived)}`,
				);
			// Each turn: the message, the answer's thought and the answer.
			assert.equal(arrived.length, 6, JSON.stringify(arrived));
			assert.ok((await browser.evaluate<number>("window.__glides")) > 0, "the transcript glides up to make room");
			// One after another: increasing delays.
			const delays = arrived.map((row) => Number.parseFloat(row.delay || "0"));
			assert.deepEqual(
				delays,
				[...delays].sort((a, b) => a - b),
			);
			assert.ok(delays.at(-1)! > 0);
		} finally {
			stop();
			chat.release();
		}
	});

	it("forgets what this device kept of sessions the server no longer has", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Still here",
			},
			BACKGROUND_CONTEXT,
		);
		const page = `http://127.0.0.1:${fixture.server.port}/s/${session.id}`;
		const keys = `new Promise((resolve) => { const open = indexedDB.open("p2-conversations"); open.onsuccess = () => { const all = open.result.transaction("kept").objectStore("kept").getAllKeys(); all.onsuccess = () => resolve(all.result); }; })`;
		await browser.open(page);
		await browser.wait(`document.querySelector('.composer textarea')`);
		// A conversation kept for a session the server does not have (deleted, or the data restored from a backup).
		const gone = "00000000-0000-4000-8000-000000000000#1";
		// Written and read back in one transaction: the open page may forget it right after (what this test checks).
		const written = await browser.evaluate<string[]>(
			`new Promise((resolve) => { const open = indexedDB.open("p2-conversations"); open.onsuccess = () => { const tx = open.result.transaction("kept", "readwrite"); const store = tx.objectStore("kept"); store.put({ key: ${JSON.stringify(gone)}, savedAt: Date.now(), view: { entries: [], docs: {} }, history: undefined, sizes: [] }); const all = store.getAllKeys(); tx.oncomplete = () => resolve(all.result); }; })`,
		);
		assert.ok(written.includes(gone));
		await browser.open(page);
		await browser.wait(
			`${keys}.then((all) => !all.includes(${JSON.stringify(gone)}) && all.includes(${JSON.stringify(`${session.id}#1`)}))`,
		);
	});

	it("shows a conversation kept on the device at once on a page that starts offline", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Kept",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await chat.send({ text: "remember me", requestId: "kept" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: remember me"), 30_000);
			const page = `http://127.0.0.1:${fixture.server.port}/s/${session.id}`;
			await browser.open(page);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: remember me')`);
			// Kept a second after it settles.
			await new Promise((resolve) => setTimeout(resolve, 1_500));

			// A cold start without a connection: the conversation and the composer are there before anything arrives.
			await browser.evaluate(`sessionStorage.setItem("offline", "1")`);
			await browser.open(page);
			await browser.wait(`Boolean(document.querySelector('.offline'))`);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: remember me')`);
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`));
			assert.equal(await browser.evaluate<number>(bubbles("remember me")), 1);
			// The context bar's space is there before its numbers: the composer area keeps its height when they come.
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.context-usage.pending'))`));
			const dock = await browser.evaluate<number>(`document.querySelector('.dock').getBoundingClientRect().height`);

			// Back online, the live view takes over: the same conversation, once.
			await browser.evaluate(`sessionStorage.removeItem("offline"); window.__offline = false`);
			await browser.wait(`!document.querySelector('.offline')`);
			await browser.wait(`Boolean(document.querySelector('.context-usage:not(.pending)'))`);
			assert.equal(
				await browser.evaluate<number>(`document.querySelector('.dock').getBoundingClientRect().height`),
				dock,
			);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: remember me')`);
			assert.equal(await browser.evaluate<number>(bubbles("remember me")), 1);
		} finally {
			stop();
			chat.release();
		}
	});

	it("keeps the one composer, focused, when a new session's first message opens the session", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(
			`document.querySelector('.composer textarea') && document.querySelector('.cwd-pick') && !document.querySelector('.offline') && document.querySelector('.model-control')?.textContent !== 'Choose model'`,
		);
		await browser.evaluate(
			`window.__composer = document.querySelector('.composer textarea'); window.__composer.focus()`,
		);
		const text = "first message, still typing";
		await browser.evaluate(draft(text));
		// Sent as Enter sends it, the focus staying in the textarea.
		await browser.evaluate(`document.querySelector('.composer').requestSubmit()`);
		await browser.wait(`location.pathname.startsWith('/s/') && ${bubbles(text)} === 1`);
		// One composer for both screens: the same textarea, focused throughout.
		assert.ok(
			await browser.evaluate<boolean>(
				`document.querySelector('.composer textarea') === window.__composer && document.activeElement === window.__composer`,
			),
			"the session opens with the same composer, still focused",
		);
	});

	it("shows a new session's first message at once and creates the session once back online", async () => {
		const catalog = await holdIn(owner, Sessions, {}, "owner");
		const before = new Set(catalog.sessions.value.map((session) => session.id));
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(
			`document.querySelector('.composer textarea') && document.querySelector('.cwd-pick') && !document.querySelector('.offline') && document.querySelector('.model-control')?.textContent !== 'Choose model'`,
		);

		// The composer's place: the new-session screen has the session screen's context bar (empty), so it stays.
		const composerTop = `Math.round(document.querySelector('.composer').getBoundingClientRect().top)`;
		const top = await browser.evaluate<number>(composerTop);
		await browser.evaluate("window.__goOffline()");
		await browser.wait(`Boolean(document.querySelector('.offline'))`);
		const text = "first message while offline";
		await browser.evaluate(draft(text));
		await browser.click("button[aria-label=Send]");
		// It leaves the composer and shows at once, on the new-session screen: the session does not exist yet.
		await browser.wait(
			`document.querySelector('.composer textarea').value === '' && ${bubbles(text)} === 1 && location.pathname === '/'`,
		);
		assert.equal(catalog.sessions.value.filter((session) => !before.has(session.id)).length, 0);
		// From here until the answer: the message never leaves the screen (creation, navigation, the worker's start).
		await browser.evaluate(
			`(() => { window.__shown = []; window.__tops = []; window.__sampler = setInterval(() => { window.__shown.push(${bubbles(text)}); window.__tops.push(${composerTop}); }, 10); })()`,
		);

		await browser.evaluate("window.__offline = false");
		await browser.wait(`location.pathname.startsWith('/s/')`);
		const id = await browser.evaluate<string>("location.pathname.slice(3)");
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 60_000);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: ${text}')`);
			assert.equal(await browser.evaluate<number>(bubbles(text)), 1, "shown once");
			const shown = await browser.evaluate<number[]>("clearInterval(window.__sampler), window.__shown");
			assert.ok(
				shown.every((count) => count === 1),
				`shown throughout: ${JSON.stringify([...new Set(shown)])}`,
			);
			assert.deepEqual(
				[...new Set(await browser.evaluate<number[]>("window.__tops"))],
				[top],
				"the composer stays in place",
			);
			assert.equal(inputs(chat.view.value, text), 1, "delivered once");
			assert.deepEqual(
				catalog.sessions.value.filter((session) => !before.has(session.id)).map((session) => session.id),
				[id],
				"one session created",
			);
		} finally {
			stop();
			chat.release();
		}
	});

	it("shows a message whose answer was lost once when its conversation opens again", async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const here = await sessions.create({ cwd: fixture.workspace, title: "Lost answer" }, BACKGROUND_CONTEXT);
		const elsewhere = await sessions.create({ cwd: fixture.workspace, title: "Not here" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: here.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.metrics(1280, 900);
			// The other conversation first, then this one inside the page: Back and Forward switch between them.
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${elsewhere.id}`);
			await browser.wait(`${row("Lost answer")} && !document.querySelector('.offline')`);
			await browser.evaluate(`${row("Lost answer")}.click()`);
			await browser.wait(`location.pathname === '/s/${here.id}' && document.querySelector('.hero.small-hero')`);
			const text = "sent, answer lost";
			await browser.evaluate(`window.__loseAnswerOf(${JSON.stringify(text)})`);
			await browser.evaluate(draft(text));
			await browser.click("button[aria-label=Send]");
			// The server has it and answers; the page never hears that, then goes offline.
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 30_000);
			await browser.wait(`Boolean(document.querySelector('.offline'))`);

			// Away and back: the conversation's view opens again, now online, and its outbox sends the message again.
			await browser.evaluate("history.back()");
			await browser.wait(`location.pathname === '/s/${elsewhere.id}'`);
			await browser.evaluate("window.__offline = false");
			await browser.wait(`!document.querySelector('.offline')`);
			await browser.evaluate(
				`(() => { window.__shown = []; window.__sampler = setInterval(() => window.__shown.push(${bubbles(text)}), 10); })()`,
			);
			await browser.evaluate("history.forward()");
			await browser.wait(
				`location.pathname === '/s/${here.id}' && window.__framesWith[${JSON.stringify(text)}] === 2 && document.querySelector('.messages')?.textContent.includes(${JSON.stringify(`Echo: ${text}`)})`,
			);
			// The retry is admitted as the first send was; the transcript's entry is the one message shown.
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			const shown = await browser.evaluate<number[]>("clearInterval(window.__sampler), window.__shown");
			assert.ok(
				shown.every((count) => count <= 1) && shown.at(-1) === 1,
				`shown once: ${JSON.stringify([...new Set(shown)])}`,
			);
			assert.equal(inputs(chat.view.value, text), 1, "delivered once");
		} finally {
			stop();
			chat.release();
		}
	});

	it("keeps showing a message whose upload fails as newer entries arrive, also in its conversation opened again", async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const here = await sessions.create({ cwd: fixture.workspace, title: "Upload fails" }, BACKGROUND_CONTEXT);
		const elsewhere = await sessions.create({ cwd: fixture.workspace, title: "Not there" }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: here.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		// Chrome fails the page's uploads while `failing`, as a dropped connection does.
		let failing = true;
		const uploads = (raw: unknown) => {
			const message = JSON.parse(String(raw)) as { method?: string; params?: { requestId: string } };
			if (message.method !== "Fetch.requestPaused" || !message.params) return;
			const { requestId } = message.params;
			void browser.call(
				failing ? "Fetch.failRequest" : "Fetch.continueRequest",
				failing ? { requestId, errorReason: "ConnectionFailed" } : { requestId },
			);
		};
		browser.socket.on("message", uploads);
		try {
			await browser.metrics(1280, 900);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${elsewhere.id}`);
			await browser.wait(`${row("Upload fails")} && !document.querySelector('.offline')`);
			await browser.evaluate(`${row("Upload fails")}.click()`);
			await browser.wait(`location.pathname === '/s/${here.id}' && document.querySelector('.hero.small-hero')`);
			writeFileSync(join(fixture.workspace, "photo.txt"), "attached\n");
			const document = (await browser.call("DOM.getDocument")) as { root: { nodeId: number } };
			const node = (await browser.call("DOM.querySelector", {
				nodeId: document.root.nodeId,
				selector: ".composer input[type=file]",
			})) as { nodeId: number };
			await browser.call("DOM.setFileInputFiles", {
				nodeId: node.nodeId,
				files: [join(fixture.workspace, "photo.txt")],
			});
			await browser.wait(`document.querySelector('.attachment-name')?.textContent === 'photo.txt'`);
			await browser.call("Fetch.enable", { patterns: [{ urlPattern: "*/upload*" }] });
			const text = "photo, upload fails";
			await browser.evaluate(draft(text));
			await browser.click("button[aria-label=Send]");
			await browser.wait(`document.querySelector('.composer textarea').value === '' && ${bubbles(text)} === 1`);

			// Another device writes to the conversation: newer entries, while the server does not have the message.
			await chat.send({ text: "from another device", requestId: "another device" }, BACKGROUND_CONTEXT);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: from another device')`);
			assert.equal(await browser.evaluate<number>(bubbles(text)), 1, "shown as newer entries arrive");
			// Away and back: the conversation's view opens again, and its outbox tries again.
			await browser.evaluate("history.back()");
			await browser.wait(`location.pathname === '/s/${elsewhere.id}'`);
			await browser.evaluate("history.forward()");
			await browser.wait(
				`location.pathname === '/s/${here.id}' && document.querySelector('.messages')?.textContent.includes('Echo: from another device')`,
			);
			assert.equal(await browser.evaluate<number>(bubbles(text)), 1, "shown in its conversation opened again");
			assert.equal(inputs(chat.view.value, text), 0, "the server does not have it");

			// Uploads work again: the next try delivers it, shown once.
			failing = false;
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 30_000);
			await browser.wait(
				`document.querySelector('.messages')?.textContent.includes(${JSON.stringify(`Echo: ${text}`)})`,
			);
			assert.equal(await browser.evaluate<number>(bubbles(text)), 1, "shown once");
			assert.equal(inputs(chat.view.value, text), 1, "delivered once");
		} finally {
			await browser.call("Fetch.disable");
			browser.socket.off("message", uploads);
			stop();
			chat.release();
		}
	});
});

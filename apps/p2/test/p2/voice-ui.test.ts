// Voice mode in a real browser (Chromium's fake microphone): the composer's microphone turns voice mode on, what the
// (fake) speech service hears becomes a message, and the agent's answer is read aloud through /voice/speak.

import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { VoiceMode, VoiceServiceStore } from "../../plugins/voice/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";
import { fakeSpeechService } from "./voice-service.ts";

/**
 * Records the microphone tracks, microphone AudioContexts, screen wake locks and voice room sockets the page opens
 * (`__voice.open()` counts those still open), and holds back the outcome of a start's next step ("microphone",
 * "constraints" or "wake lock") until the test releases it, as a slow device or a permission prompt does. The browser's
 * own getUserMedia, applyConstraints and wakeLock.request do the work, and give or refuse what they give or refuse.
 */
const RECORDER = `(() => {
	const opened = { tracks: [], contexts: [], locks: [], sockets: [] };
	const holds = new Map();
	const outcome = async (step, promise) => {
		const settled = await promise.then((value) => ({ value }), (error) => ({ error }));
		const hold = holds.get(step);
		if (hold) {
			hold.waiting++;
			await hold.gate;
		}
		if ("error" in settled) throw settled.error;
		return settled.value;
	};
	window.__voice = {
		hold(step) {
			let release;
			const gate = new Promise((resolve) => (release = resolve));
			holds.set(step, { gate, release, waiting: 0 });
		},
		waiting: (step) => holds.get(step)?.waiting ?? 0,
		release(step) {
			holds.get(step)?.release();
			holds.delete(step);
		},
		open: () => ({
			microphones: opened.tracks.filter((track) => track.readyState === "live").length,
			contexts: opened.contexts.filter((context) => context.state !== "closed").length,
			wakeLocks: opened.locks.filter((lock) => !lock.released).length,
			rooms: opened.sockets.filter((socket) => socket.readyState < WebSocket.CLOSING).length,
		}),
	};
	const media = navigator.mediaDevices;
	const getUserMedia = media.getUserMedia.bind(media);
	media.getUserMedia = (constraints) =>
		outcome("microphone", getUserMedia(constraints).then((stream) => {
			opened.tracks.push(...stream.getTracks());
			return stream;
		}));
	const applyConstraints = MediaStreamTrack.prototype.applyConstraints;
	MediaStreamTrack.prototype.applyConstraints = function (constraints) {
		return outcome("constraints", applyConstraints.call(this, constraints));
	};
	const request = navigator.wakeLock.request.bind(navigator.wakeLock);
	navigator.wakeLock.request = (type) =>
		outcome("wake lock", request(type).then((lock) => {
			opened.locks.push(lock);
			return lock;
		}));
	window.AudioContext = class extends AudioContext {
		createMediaStreamSource(stream) {
			opened.contexts.push(this);
			return super.createMediaStreamSource(stream);
		}
	};
	window.WebSocket = class extends WebSocket {
		constructor(url, protocols) {
			super(url, protocols);
			if (String(url).includes("/voice/room")) opened.sockets.push(this);
		}
	};
})()`;

describe("voice mode in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let speech: Awaited<ReturnType<typeof fakeSpeechService>>;
	const permitMicrophone = (setting: "granted" | "denied") =>
		browser.call("Browser.setPermission", { permission: { name: "microphone" }, setting });
	before(async () => {
		fixture = await startFixture({ web: true });
		speech = await fakeSpeechService("token", { utterance: "What time is it?" });
		writeFileSync(join(fixture.dataDir, "voice.json"), JSON.stringify({ url: speech.url, token: "token" }));
		// The server watches voice.json from its start, and macOS may not report a file written right after: ask again.
		const store = fixture.server.host.hold(VoiceServiceStore, {}, BACKGROUND_CONTEXT);
		await store.refresh(BACKGROUND_CONTEXT);
		await until(store.voices, (voices) => voices !== null);
		store.release();
		browser = await Browser.start([
			"--use-fake-device-for-media-stream",
			// Run WebAudio's clock on Chromium's fake output, not a physical audio device.
			"--disable-audio-output",
			"--autoplay-policy=no-user-gesture-required",
		]);
		// The microphone is allowed, as once its prompt is answered; a test can refuse it (Chromium's fake media UI can't).
		await permitMicrophone("granted");
	});
	after(async () => {
		await browser?.close();
		speech?.close();
		await fixture?.close();
	});

	it("sends what it hears and reads the answer aloud", async () => {
		const owner = fixture.browser();
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const input = { session: session.id, conversation: 1 };
		const chat = await holdIn(owner, Chat, input, "participant");
		const keep = follow(chat.view, () => {});
		const mode = await holdIn(owner, VoiceMode, input, "owner");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		await browser.click(".voice-chip");
		await browser.wait('document.querySelector(".voice-orb")');
		await until(mode.enabled, (enabled) => enabled);
		// The composer holds only the orb: what voice mode does is its label, no text beside it.
		await browser.wait(
			'document.querySelector(".voice-chip")?.getAttribute("aria-label")?.includes("Turn voice mode off")',
		);
		assert.equal(
			await browser.evaluate<boolean>('Boolean(document.querySelector(".voice-status, .voice-name"))'),
			false,
		);
		const view = await until(chat.view, (value) =>
			JSON.stringify(value?.entries ?? []).includes("Echo: What time is it?"),
		);
		assert(view);
		await poll(() => speech.spoken.some((said) => said.text === "Echo: What time is it?"), 20_000, "answer spoken");
		assert.deepEqual(
			{ engine: speech.spoken.at(-1)?.engine, voice: speech.spoken.at(-1)?.voice },
			{ engine: "supertonic", voice: "supertonic-F1" },
		);
		// Muted: still in voice mode, but no microphone audio reaches the room, and the room drops what it heard.
		await browser.wait('!document.querySelector(".voice-orb.speaking, .voice-orb.preparing")');
		await browser.click(".voice-mute");
		await browser.wait('document.querySelector(".voice-mute")?.getAttribute("aria-pressed") === "true"');
		await poll(() => speech.commands.some(({ command }) => command.type === "reset"), 5000, "reset on mute");
		const heard = speech.received.length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(speech.received.length, heard, "nothing sent while muted");
		assert(await browser.evaluate<boolean>('Boolean(document.querySelector(".voice-orb"))'), "voice mode stays on");
		await browser.click(".voice-mute");
		await poll(() => speech.received.length > heard, 5000, "audio again once unmuted");
		// Leaving the conversation (home here; a subagent's the same) suspends voice mode: the orb goes, the switch stays
		// on. Coming back starts it again.
		await browser.evaluate('(history.pushState(null, "", "/"), dispatchEvent(new PopStateEvent("popstate")), true)');
		await browser.wait('!document.querySelector(".voice-orb")');
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(mode.enabled.value, true, "suspended, not switched off");
		await browser.evaluate("(history.back(), true)");
		await browser.wait('document.querySelector(".voice-orb")');
		assert.equal(mode.enabled.value, true);
		// Off again (once the answer is read: a tap while it is read stops only the speech): the switch follows.
		await browser.click(".voice-chip");
		await browser.wait('!document.querySelector(".voice-orb") && !document.querySelector(".voice-mute")');
		await until(mode.enabled, (enabled) => !enabled);
		// The button follows voice.json live, without a reload.
		const file = join(fixture.dataDir, "voice.json");
		renameSync(file, `${file}.away`);
		await browser.wait('!document.querySelector(".voice-chip")');
		renameSync(`${file}.away`, file);
		await browser.wait('document.querySelector(".voice-chip")');
		keep();
		chat.release();
		mode.release();
	});

	it("a start turned off while it waits leaves nothing open and no error; the next start owns voice mode", async () => {
		const session = await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const { identifier } = (await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER })) as {
			identifier: string;
		};
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		const tap = () => browser.click(".voice-chip");
		const open = () => browser.evaluate<Record<string, number>>("window.__voice.open()");
		const hold = (step: string) => browser.evaluate(`window.__voice.hold(${JSON.stringify(step)})`);
		const held = (step: string, starts: number) =>
			browser.wait(`window.__voice.waiting(${JSON.stringify(step)}) === ${starts}`);
		const release = (step: string) => browser.evaluate(`window.__voice.release(${JSON.stringify(step)})`);
		// Off and on again while the first start waits for one of its steps: the second start is voice mode, and the first
		// releases what that step brings it.
		for (const step of ["microphone", "constraints", "wake lock"]) {
			const when = `on again while the first start waited for the ${step}`;
			await hold(step);
			await tap();
			await held(step, 1);
			await tap();
			await tap();
			await held(step, 2);
			await release(step);
			// It listens with one microphone, AudioContext, wake lock and room; off, nothing stays open.
			await browser.wait('document.querySelector(".voice-orb.listening")');
			assert.deepEqual(await open(), { microphones: 1, contexts: 1, wakeLocks: 1, rooms: 1 }, when);
			await tap();
			await browser.wait('!document.querySelector(".voice-orb")');
			assert.deepEqual(await open(), { microphones: 0, contexts: 0, wakeLocks: 0, rooms: 0 }, when);
		}
		// A refused microphone fails the start that is voice mode; refused only after voice mode went off, it shows nothing.
		await permitMicrophone("denied");
		await tap();
		await browser.wait('document.querySelector(".voice-error-dot")');
		await hold("microphone");
		await tap();
		await held("microphone", 1);
		await tap();
		await release("microphone");
		// The refusal would show at once (the error above did): give it a moment.
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(
			await browser.evaluate<string>('document.querySelector(".voice-chip").getAttribute("aria-label")'),
			"Turn voice mode on",
			"refused after off",
		);
		await permitMicrophone("granted");
		await browser.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
	});
});

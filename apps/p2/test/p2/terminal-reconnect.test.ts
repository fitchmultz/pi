// A terminal whose socket drops gets a new one and keeps working, and a terminal closed while the socket was down is
// not shown once it is back (Terminal.tsx with src/web/reconnect.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { TerminalServices } from "../../plugins/terminals/contract.ts";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { encodeFrame } from "../../plugins/terminals/protocol.ts";
import { Browser, browserTests } from "./browser.ts";
import { APP, holdIn, startFixture } from "./helpers.ts";

let unavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	unavailable = String(error);
}

test(
	"a dropped terminal socket is replaced: typing reaches the shell again, a terminal closed meanwhile is not shown",
	{ timeout: 60000, skip: !browserTests ? "no Chromium" : unavailable },
	async () => {
		const shell = process.env.SHELL;
		process.env.SHELL = "/bin/sh";
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			const owner = fixture.browser();
			const id = (
				await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
			).id;
			browser = await Browser.start();
			await browser.signIn(fixture.owner);
			const page = browser;
			await page.call("Page.addScriptToEvaluateOnNewDocument", {
				source: `
			window.terminalSockets=[];window.terminalOffline=false;
			window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){
				const terminal=String(args[0]).includes('/terminal');
				// Offline: the terminal socket fails to connect, as on a dead network.
				const socket=Reflect.construct(Target,terminal&&window.terminalOffline?['ws://127.0.0.1:9/terminal']:args);
				if(terminal)window.terminalSockets.push(socket);
				return socket;
			}});`,
			});
			await page.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
			await page.wait("document.querySelector('button[aria-label=Terminal]')");
			await page.evaluate("document.querySelector('button[aria-label=Terminal]').click()");
			const prompt = "[...document.querySelectorAll('.terminal-row')].some(row => /[$#]/.test(row.textContent))";
			await page.wait(prompt);
			await page.wait("window.terminalSockets.length === 1 && window.terminalSockets[0].readyState === 1");

			await page.evaluate("window.terminalSockets[0].close()");
			await page.wait("window.terminalSockets.length === 2 && window.terminalSockets[1].readyState === 1");
			await page.wait(prompt);

			await page.evaluate("document.querySelector('.terminal-input').focus()");
			await page.call("Input.insertText", { text: "echo reconnected-$((40+2))" });
			await page.call("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				text: "\r",
			});
			await page.call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
			});
			// Only the shell computes 42: the keys went over the new socket.
			await page.wait(
				"[...document.querySelectorAll('.terminal-row')].some(row => row.textContent.includes('reconnected-42'))",
			);

			// The socket drops and stays down while the shown terminal is closed elsewhere (the agent's kill-window), so the
			// panel never hears of it. Back online, it shows no terminal rather than the closed one's last screen, here
			// scrolled back so that its scrollbar shows.
			const service = (await fixture.server.host.registry(TerminalServices, BACKGROUND_CONTEXT)).value!.service;
			await service.call({
				op: "send",
				sessionId: id,
				key: "scrollback",
				target: "1",
				keys: ["seq 1 300", "Enter"],
				literal: false,
			});
			const rows = "[...document.querySelectorAll('.terminal-row')]";
			// The next prompt too, so that no output arrives after the scroll.
			await page.wait(`${rows}.some(row => row.textContent.trim() === '300') && ${prompt}`);
			const screen = await page.evaluate<{ x: number; y: number }>(
				"(({ x, y, width, height }) => ({ x: x + width / 2, y: y + height / 2 }))(document.querySelector('.terminal-screen').getBoundingClientRect())",
			);
			await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...screen, deltaX: 0, deltaY: -400 });
			const scrollbar = "!document.querySelector('.terminal-scrollbar').hidden";
			await page.wait(scrollbar);
			await page.evaluate("window.terminalOffline = true; window.terminalSockets.at(-1).close()");
			await service.call({ op: "close", sessionId: id, key: "closed-while-offline", target: "1" });
			const sockets = await page.evaluate<number>("window.terminalSockets.length");
			await page.evaluate("window.terminalOffline = false");
			await page.wait(
				`window.terminalSockets.length > ${sockets} && window.terminalSockets.at(-1).readyState === 1`,
			);
			await page.wait("document.querySelector('.terminal-start')");
			assert.equal(await page.evaluate<boolean>(`${rows}.some(row => row.textContent.trim())`), false);
			assert.equal(await page.evaluate<boolean>(scrollbar), false);
		} finally {
			await browser?.close();
			const host = await connectTerminalHost(fixture.dataDir, APP);
			host.resume();
			host.write(encodeFrame({ type: "shutdown" }));
			await new Promise((resolve) => host.once("close", resolve));
			await fixture.close();
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
		}
	},
);

import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type LaneWatchEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { activateBuiltinClientServices, openClientRuntime } from "./client-runtime.ts";
import type { AgentOperationResponse } from "./services/agent-controller.ts";
import type { SessionAddress } from "./services/sessions.ts";

export type ClientResult =
	| {
			readonly kind: "list";
			readonly sessions: readonly SessionAddress[];
	  }
	| { readonly kind: "attached"; readonly serverId: string; readonly sessionId: string }
	| { readonly kind: "prompted"; readonly serverId: string; readonly sessionId: string; readonly text: string };

export interface RunClientOptions {
	/** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
	/** Receives snapshot-ordered main-lane events, awaited through prompt completion or suspension. */
	readonly onEvent?: (event: LaneWatchEvent) => void | Promise<void>;
}

/** Discover servers, then list Sessions, attach to one, or create one for a prompt. */
export async function runClient(command: ClientCommand, options: RunClientOptions = {}): Promise<ClientResult> {
	const runtime = await openClientRuntime(command, { directory: options.directory });
	try {
		const discovered = await Promise.all(runtime.servers.map(activateBuiltinClientServices));
		let sessionId = command.sessionId;
		if (sessionId === undefined && command.prompt === undefined) {
			return {
				kind: "list",
				sessions: discovered
					.flatMap(({ route, directory }) =>
						directory.state.value!.sessions.map(({ sessionId }) => ({ serverId: route.serverId, sessionId })),
					)
					.sort(
						(left, right) =>
							left.serverId.localeCompare(right.serverId) || left.sessionId.localeCompare(right.sessionId),
					),
			};
		}

		let match: (typeof discovered)[number];
		if (sessionId === undefined) {
			if (discovered.length !== 1) {
				throw new Error("Client prompt requires exactly one discovered server to create a Session");
			}
			match = discovered[0]!;
			sessionId = (await match.management.create({}, BACKGROUND_CONTEXT)).sessionId;
		} else {
			const selectedSessionId = sessionId;
			const matches = discovered.filter((candidate) =>
				candidate.directory.state.value!.sessions.some(({ sessionId }) => sessionId === selectedSessionId),
			);
			if (matches.length > 1) {
				throw new Error(`Session ${selectedSessionId} is available from more than one server`);
			}
			const existing = matches[0];
			if (existing) {
				match = existing;
			} else {
				if (command.connect?.transport === "radius" || command.prompt === undefined || discovered.length !== 1) {
					throw new Error(`No discovered server contains session ${selectedSessionId}`);
				}
				match = discovered[0]!;
				await match.management.create({ id: selectedSessionId }, BACKGROUND_CONTEXT);
			}
		}
		await match.plugins.prepareSession(
			{
				sessionId,
				packagePaths: command.pluginPackages?.map((packagePath) => resolve(packagePath)) ?? null,
			},
			BACKGROUND_CONTEXT,
		);
		await match.management.attach(sessionId, BACKGROUND_CONTEXT);
		if (command.prompt === undefined) {
			return { kind: "attached", serverId: match.route.serverId, sessionId };
		}

		const agent = match.agent;
		const completedText = new Map<string, string>();
		const finishedRuns = new Set<string>();
		let waiting: { operationId: string; resolve(): void } | undefined;
		let removeConnectionListener: (() => void) | undefined;
		let removeAttachmentListener: (() => void) | undefined;
		let deliveryTail = Promise.resolve();
		const unsubscribe = match.transcript.state.subscribe((value, _context, delivery) => {
			if (delivery.kind !== "update" || value.event === null) return;
			const event = value.event;
			if (event.type === "run_end" || event.type === "run_suspend") {
				finishedRuns.add(event.runId);
				if (waiting?.operationId === event.runId) waiting.resolve();
			}
			deliveryTail = deliveryTail.then(async () => {
				if (event.type === "message_end" && event.runId !== undefined && event.message.role === "assistant") {
					completedText.set(event.runId, messageText(event.message));
				}
				await options.onEvent?.(event);
			});
			// Report callback failures after the prompt settles, without an unhandled rejection meanwhile.
			void deliveryTail.catch(() => {});
		});
		if (match.transcript.state.value?.snapshot === null || match.transcript.state.value?.snapshot === undefined) {
			unsubscribe();
			throw new Error("Transcript has no initialized snapshot");
		}
		let response: AgentOperationResponse;
		try {
			response = await agent.prompt({ message: command.prompt, images: null }, BACKGROUND_CONTEXT);
			// The operation reply and passive transcript delivery settle independently.
			if (response.accepted && !finishedRuns.has(response.operationId)) {
				const operationId = response.operationId;
				await new Promise<void>((resolve, reject) => {
					waiting = { operationId, resolve };
					removeConnectionListener = match.client.onConnectionStateChange(({ state, error }) => {
						if (state === "disconnected")
							reject(error ?? new Error("Client disconnected before prompt events arrived"));
					});
					removeAttachmentListener = match.client.onAttachmentChange((attachment) => {
						if (attachment?.sessionId !== sessionId)
							reject(new Error("Session detached before prompt events arrived"));
					});
					if (!match.client.connected) reject(new Error("Client disconnected before prompt events arrived"));
					else if (match.client.attachment?.sessionId !== sessionId)
						reject(new Error("Session detached before prompt events arrived"));
				});
			}
		} finally {
			removeConnectionListener?.();
			removeAttachmentListener?.();
			unsubscribe();
			await deliveryTail;
		}
		if (!response.accepted) throw new Error(response.error.message);
		if (response.error !== null) throw new Error(response.error.message);
		return {
			kind: "prompted",
			serverId: match.route.serverId,
			sessionId,
			text: completedText.get(response.operationId) ?? "",
		};
	} finally {
		await runtime.dispose();
	}
}

function messageText(message: AssistantMessage): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
}

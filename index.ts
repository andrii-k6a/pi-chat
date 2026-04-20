import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	CHAT_CONFIG_PATH,
	ensureChatHome,
	listConfiguredConversations,
	loadChatConfig,
	resolveConversation,
} from "./src/config.js";
import { connectLive } from "./src/live/index.js";
import type { LiveConnection } from "./src/live/types.js";
import { ConversationRuntime } from "./src/runtime.js";
import { runChatConfigUI } from "./src/tui/chat-config.js";
import { runWithLoader, selectItem, showNotice } from "./src/tui/dialogs.js";

function buildChatSystemPromptSuffix(service: string, mode: "dm" | "mention", channelName: string): string {
	return `

pi-chat is active.
- Current connected remote chat: ${service} ${mode} ${channelName}.
- User messages injected by pi-chat come from that remote chat connected to this pi session.
- Each [chat] message contains only the new incoming chat messages since the previous trigger, not the full chat history.
- In channel mode, people may talk around you, but only mentions create turns.
- In DM mode, users talk to you directly and each inbound message creates a turn.
- The last line in the transcript is the triggering user message to react to.
- Reply as the bot for that remote chat.
- Attachment file paths listed in the transcript are local files on disk. Read them as needed.
- If the user asked for files or generated artifacts, use the chat_attach tool so pi-chat can send them back to the remote conversation.
- Use the chat_history tool to look up older messages from the current chat log by text query or date range when needed.
- Your final response is treated as the outbound reply for that remote conversation.`;
}

type AssistantSummary = {
	text?: string;
	stopReason?: string;
	errorMessage?: string;
};

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
	if (!signal) return new Promise(() => undefined);
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(abortError()), { once: true });
	});
}

function extractAssistantSummary(messages: unknown[]): AssistantSummary {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const value = message as Record<string, unknown>;
		if (value.role !== "assistant") continue;
		const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
		const errorMessage = typeof value.errorMessage === "string" ? value.errorMessage : undefined;
		const content = Array.isArray(value.content) ? value.content : [];
		const text = content
			.filter(
				(block): block is { type: string; text?: string } =>
					typeof block === "object" && block !== null && "type" in block,
			)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
		return { text: text || undefined, stopReason, errorMessage };
	}
	return {};
}

export default function (pi: ExtensionAPI) {
	let runtime: ConversationRuntime | undefined;
	let liveConnection: LiveConnection | undefined;
	let ownerId = `pi-chat-${process.pid}-${randomUUID()}`;
	let chatTurnInFlight = false;
	let configLoadedAtLeastOnce = false;
	let currentAbort: (() => void) | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingPreviewText = "";
	let queuedOutboundAttachments: string[] = [];
	let previewChain: Promise<void> = Promise.resolve();
	let pendingChatDispatch = false;

	async function resolveSafePath(inputPath: string, cwd: string): Promise<string> {
		const stripped = inputPath.replace(/^@+/, "");
		const resolved = resolve(cwd, stripped);
		try {
			return await realpath(resolved);
		} catch {
			return resolved;
		}
	}

	async function isPathWithinCwd(inputPath: string, cwd: string): Promise<boolean> {
		const base = await realpath(cwd).catch(() => resolve(cwd));
		const target = await resolveSafePath(inputPath, cwd);
		const rel = relative(base, target);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	}

	async function loadConfigOnce() {
		if (configLoadedAtLeastOnce) return;
		await ensureChatHome();
		configLoadedAtLeastOnce = true;
	}

	pi.registerMessageRenderer("chat-context", (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", theme.bold("[pi-chat]"))} ${String(message.content)}`, 0, 0));
		return box;
	});

	function showChatContextMessage(): void {
		if (!runtime) return;
		const channelName = runtime.conversation.channel.name ?? runtime.conversation.channelKey;
		const mode = runtime.conversation.channel.dm ? "dm" : "mention";
		const service = runtime.conversation.service;
		const systemPromptAdditions = buildChatSystemPromptSuffix(service, mode, channelName).trim();
		const intro = [
			`Connected to ${service} ${mode} ${channelName}.`,
			"",
			"System prompt additions:",
			systemPromptAdditions,
		].join("\n");
		pi.sendMessage({ customType: "chat-context", content: intro, display: true });
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "chat");
		if (error) {
			ctx.ui.setStatus("chat", `${label} ${theme.fg("error", error)}`);
			return;
		}
		if (!runtime) {
			ctx.ui.setStatus("chat", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		const status = runtime.getStatus();
		const details = [status.conversationName];
		if (status.hasActiveJob) details.push("active");
		if (status.queueLength > 0) details.push(`q:${status.queueLength}`);
		ctx.ui.setStatus("chat", `${label} ${theme.fg("success", details.join(" | "))}`);
	}

	function startTypingLoop(): void {
		if (!liveConnection || typingInterval) return;
		void liveConnection.startTyping();
		typingInterval = setInterval(() => {
			void liveConnection?.startTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (typingInterval) {
			clearInterval(typingInterval);
			typingInterval = undefined;
		}
		void liveConnection?.stopTyping();
	}

	async function flushPreview(done = false): Promise<void> {
		if (previewTimer) {
			clearTimeout(previewTimer);
			previewTimer = undefined;
		}
		if (!liveConnection || !chatTurnInFlight) return;
		previewChain = previewChain
			.then(async () => {
				if (!liveConnection || !chatTurnInFlight) return;
				await liveConnection.syncPreview(pendingPreviewText, done);
			})
			.catch(() => undefined);
		await previewChain;
	}

	function clearPreviewTimer(): void {
		if (!previewTimer) return;
		clearTimeout(previewTimer);
		previewTimer = undefined;
	}

	function schedulePreview(text: string): void {
		pendingPreviewText = text;
		if (previewTimer) return;
		previewTimer = setTimeout(() => {
			void flushPreview(false);
		}, 750);
	}

	pi.registerTool({
		name: "chat_history",
		label: "Chat History",
		description: "Search older messages from the current connected chat log by text or date range.",
		promptSnippet: "Search older messages from the current connected chat log.",
		promptGuidelines: [
			"Use chat_history when you need older remote chat context that is not present in the current transcript delta.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case-insensitive text to search for" })),
			after: Type.Optional(Type.String({ description: "ISO timestamp lower bound, inclusive" })),
			before: Type.Optional(Type.String({ description: "ISO timestamp upper bound, inclusive" })),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of messages to return", minimum: 1, maximum: 200 }),
			),
		}),
		renderCall(args, theme) {
			const parts: string[] = [];
			if (typeof args.query === "string" && args.query.trim()) parts.push(`query=${JSON.stringify(args.query)}`);
			if (typeof args.after === "string" && args.after.trim()) parts.push(`after=${args.after}`);
			if (typeof args.before === "string" && args.before.trim()) parts.push(`before=${args.before}`);
			if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("chat_history"))} ${theme.fg("accent", parts.join(" ") || "recent history")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = (result.details ?? {}) as { count?: number };
			const textBlocks = result.content.filter(
				(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
			);
			const body =
				textBlocks
					.map((item) => item.text)
					.join("\n")
					.trim() || "No matching chat history found.";
			const lines = body.split("\n");
			const preview = lines.slice(0, 8).join("\n");
			const suffix = lines.length > 8 ? `\n${theme.fg("dim", `… ${lines.length - 8} more line(s)`)}` : "";
			return new Text(
				`${theme.fg("accent", theme.bold(`history (${details.count ?? 0} match${details.count === 1 ? "" : "es"})`))}\n${preview}${suffix}`,
				0,
				0,
			);
		},
		async execute(_toolCallId, params, signal) {
			if (!chatTurnInFlight || !runtime)
				throw new Error("chat_history can only be used while replying to an active chat turn");
			signal?.throwIfAborted?.();
			const results = runtime.findHistory(params);
			const lines = results.map((record) => {
				if (record.type === "inbound") {
					return `- [${record.timestamp}] ${record.userName ?? record.userId}: ${record.text}`;
				}
				if (record.type === "outbound") {
					return `- [${record.timestamp}] assistant: ${record.text}`;
				}
				return `- [${record.timestamp}] ${record.type}`;
			});
			return {
				content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No matching chat history found." }],
				details: { count: results.length },
			};
		},
	});

	pi.registerTool({
		name: "chat_attach",
		label: "Chat Attach",
		description: "Queue one or more local files to be sent with the next pi-chat reply.",
		promptSnippet: "Queue local files to be sent with the next remote chat reply.",
		promptGuidelines: [
			"When a remote chat user asked for a file or generated artifact, use chat_attach with local file paths.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: 10 }),
		}),
		renderCall(args, theme) {
			const files = Array.isArray(args.paths) ? args.paths : [];
			const preview = files.slice(0, 3).join(", ");
			const suffix = files.length > 3 ? ` +${files.length - 3} more` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("chat_attach"))} ${theme.fg("accent", preview || "(none)")}${theme.fg("dim", suffix)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = (result.details ?? {}) as { paths?: string[] };
			const paths = details.paths ?? [];
			return new Text(
				`${theme.fg("accent", theme.bold(`queued ${paths.length} attachment${paths.length === 1 ? "" : "s"}`))}${paths.length > 0 ? `\n${paths.join("\n")}` : ""}`,
				0,
				0,
			);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!chatTurnInFlight) throw new Error("chat_attach can only be used while replying to an active chat turn");
			signal?.throwIfAborted?.();
			for (const path of params.paths) {
				signal?.throwIfAborted?.();
				if (!(await isPathWithinCwd(path, ctx.cwd))) throw new Error(`Attachments must be inside cwd: ${path}`);
				const fileStats = await stat(path);
				if (!fileStats.isFile()) throw new Error(`Not a file: ${path}`);
				queuedOutboundAttachments.push(await resolveSafePath(path, ctx.cwd));
			}
			return {
				content: [{ type: "text", text: `Queued ${params.paths.length} attachment(s).` }],
				details: { paths: params.paths },
			};
		},
	});

	async function tryDispatch(ctx: ExtensionContext): Promise<void> {
		if (!runtime || chatTurnInFlight || !ctx.isIdle()) return;
		const next = runtime.beginNextJob();
		if (!next) {
			updateStatus(ctx);
			return;
		}
		try {
			chatTurnInFlight = true;
			queuedOutboundAttachments = [];
			pendingPreviewText = "";
			previewChain = Promise.resolve();
			pendingChatDispatch = true;
			startTypingLoop();
			pi.sendUserMessage(next.prompt);
			updateStatus(ctx);
		} catch (error) {
			pendingChatDispatch = false;
			chatTurnInFlight = false;
			stopTypingLoop();
			const message = error instanceof Error ? error.message : String(error);
			await runtime.failActiveJob(`dispatch failed: ${message}`);
			updateStatus(ctx, message);
		}
	}

	async function disconnectRuntime(ctx: ExtensionContext): Promise<void> {
		stopTypingLoop();
		clearPreviewTimer();
		pendingPreviewText = "";
		const connection = liveConnection;
		liveConnection = undefined;
		if (connection) await connection.disconnect().catch(() => undefined);
		if (!runtime) {
			updateStatus(ctx);
			return;
		}
		const current = runtime;
		runtime = undefined;
		chatTurnInFlight = false;
		await current.disconnect();
		updateStatus(ctx);
	}

	pi.on("tool_call", async (event, ctx) => {
		const fileTools = ["read", "write", "edit"];
		const pathTools = ["ls", "grep", "find"];
		if (fileTools.includes(event.toolName)) {
			const value = event as { input?: { path?: string } };
			const path = value.input?.path;
			if (path && !(await isPathWithinCwd(path, ctx.cwd))) {
				return { block: true, reason: `pi-chat only allows file operations within cwd: ${ctx.cwd}` };
			}
			return;
		}
		if (pathTools.includes(event.toolName)) {
			const value = event as { input?: { path?: string } };
			const path = value.input?.path;
			if (path && !(await isPathWithinCwd(path, ctx.cwd))) {
				return { block: true, reason: `pi-chat only allows operations within cwd: ${ctx.cwd}` };
			}
			return;
		}
		if (!chatTurnInFlight) return;
		if (event.toolName === "chat_attach" || event.toolName === "chat_history") return;
		return {
			block: true,
			reason: "pi-chat remote turns only allow read, write, edit, ls, grep, find, chat_history, and chat_attach",
		};
	});

	pi.registerCommand("chat-config", {
		description: "Configure pi-chat Discord and Telegram accounts and channels",
		handler: async (_args, ctx) => {
			await loadConfigOnce();
			await runChatConfigUI(ctx);
		},
	});

	pi.registerCommand("chat-list", {
		description: "List configured channels",
		handler: async (_args, ctx) => {
			await loadConfigOnce();
			const config = await loadChatConfig();
			const configured = listConfiguredConversations(config);
			if (configured.length === 0) {
				ctx.ui.notify(`No configured channels. Run /chat-config. (${CHAT_CONFIG_PATH})`, "warning");
				return;
			}
			ctx.ui.notify(configured.map((item) => item.conversationName).join("\n"), "info");
		},
	});

	pi.registerCommand("chat-connect", {
		description: "Connect this pi session to account/channel",
		handler: async (args, ctx) => {
			await loadConfigOnce();
			const config = await loadChatConfig();
			let spec = args.trim();
			if (!spec) {
				const configured = listConfiguredConversations(config);
				if (configured.length === 0) {
					ctx.ui.notify(`No configured channels. Run /chat-config. (${CHAT_CONFIG_PATH})`, "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /chat-connect <account/channel>", "warning");
					return;
				}
				const items = configured.map((item) => ({
					value: item.conversationId,
					label: item.conversationName,
					description: item.conversationId,
				}));
				spec = (await selectItem(ctx, "Connect pi-chat channel", items)) || "";
				if (!spec) return;
			}
			const conversation = resolveConversation(config, spec);
			if (!conversation) {
				ctx.ui.notify(`Unknown configured channel: ${spec}`, "error");
				return;
			}
			await disconnectRuntime(ctx);
			const result = await runWithLoader(ctx, `Connecting ${conversation.conversationName}...`, async () => {
				runtime = await ConversationRuntime.connect(conversation, ownerId);
				liveConnection = await connectLive(
					conversation,
					{
						onMessage: async (input, checkpoint) => {
							if (!runtime) return;
							const lower = input.text.trim().toLowerCase();
							if (runtime.isArmed() && (lower === "stop" || lower === "/stop")) {
								if (currentAbort) {
									currentAbort();
									await liveConnection?.sendImmediate("Aborted current turn.");
								} else {
									await liveConnection?.sendImmediate("No active turn.");
								}
								return;
							}
							await runtime.ingestInbound(input, checkpoint);
							await tryDispatch(ctx);
						},
						onCaughtUp: async () => {
							runtime?.armAfterCurrentTail();
						},
						onError: async (error) => {
							if (runtime) await runtime.appendError(error.message);
							updateStatus(ctx, error.message);
						},
					},
					runtime.getLastCheckpoint(),
				);
			});
			if (result.error) {
				if (liveConnection) {
					await liveConnection.disconnect().catch(() => undefined);
					liveConnection = undefined;
				}
				if (runtime) {
					await runtime.disconnect().catch(() => undefined);
				}
				runtime = undefined;
				updateStatus(ctx, result.error);
				await showNotice(ctx, "Connect error", result.error, "error");
				return;
			}
			ctx.ui.notify(`Connected ${conversation.conversationName}`, "info");
			showChatContextMessage();
			updateStatus(ctx);
			await tryDispatch(ctx);
		},
	});

	pi.registerCommand("chat-disconnect", {
		description: "Disconnect the current pi-chat channel",
		handler: async (_args, ctx) => {
			await disconnectRuntime(ctx);
		},
	});

	pi.registerCommand("chat-status", {
		description: "Show pi-chat connection status",
		handler: async (_args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("pi-chat disconnected", "info");
				return;
			}
			const status = runtime.getStatus();
			ctx.ui.notify(
				[
					`channel: ${status.conversationName}`,
					`queue: ${status.queueLength}`,
					`active: ${status.hasActiveJob ? "yes" : "no"}`,
					`records: ${status.recordCount}`,
					`log: ${status.logPath}`,
				].join(" | "),
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await loadConfigOnce();
		ownerId = `pi-chat-${process.pid}-${randomUUID()}`;
		const cwd = ctx.cwd;
		const builtins = [
			createReadToolDefinition(cwd),
			createWriteToolDefinition(cwd),
			createEditToolDefinition(cwd),
			createLsToolDefinition(cwd),
			createGrepToolDefinition(cwd),
			createFindToolDefinition(cwd),
		];
		for (const tool of builtins) {
			pi.registerTool(tool as unknown as Parameters<typeof pi.registerTool>[0]);
		}
		pi.setActiveTools(["read", "write", "edit", "ls", "grep", "find", "chat_history", "chat_attach"]);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await disconnectRuntime(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!chatTurnInFlight || !liveConnection) return;
		const message = event.message as unknown as Record<string, unknown>;
		if (message.role !== "assistant") return;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.filter(
				(block): block is { type: string; text?: string } =>
					typeof block === "object" && block !== null && "type" in block,
			)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("");
		schedulePreview(text);
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const value = message as unknown as Record<string, unknown>;
				return !(value && value.customType === "chat-context");
			}),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!pendingChatDispatch) return;
		pendingChatDispatch = false;
		const channelName = runtime?.conversation.channel.name ?? runtime?.conversation.channelKey ?? "chat";
		const mode = runtime?.conversation.channel.dm ? "dm" : "mention";
		const service = runtime?.conversation.service ?? "chat";
		return {
			systemPrompt: event.systemPrompt + buildChatSystemPromptSuffix(service, mode, channelName),
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		currentAbort = undefined;
		if (!runtime || !chatTurnInFlight) {
			clearPreviewTimer();
			stopTypingLoop();
			updateStatus(ctx);
			return;
		}
		const summary = extractAssistantSummary(event.messages as unknown[]);
		if (summary.stopReason === "aborted") {
			clearPreviewTimer();
			stopTypingLoop();
			chatTurnInFlight = false;
			await previewChain.catch(() => undefined);
			await runtime.failActiveJob("aborted");
			updateStatus(ctx);
			await tryDispatch(ctx);
			return;
		}
		if (summary.stopReason === "error") {
			clearPreviewTimer();
			stopTypingLoop();
			chatTurnInFlight = false;
			await previewChain.catch(() => undefined);
			const errorMessage = summary.errorMessage || "agent error";
			await runtime.failActiveJob(errorMessage);
			if (liveConnection) {
				try {
					await liveConnection.sendImmediate(`pi-chat error: ${errorMessage}`);
				} catch {
					// ignore secondary send failure
				}
			}
			ctx.ui.notify(errorMessage, "error");
			updateStatus(ctx, errorMessage);
			await tryDispatch(ctx);
			return;
		}
		let remoteMessageId: string | undefined;
		const attachmentPaths = [...queuedOutboundAttachments];
		queuedOutboundAttachments = [];
		if (liveConnection) {
			try {
				clearPreviewTimer();
				stopTypingLoop();
				await previewChain.catch(() => undefined);
				pendingPreviewText = summary.text || (attachmentPaths.length > 0 ? "Attached requested file(s)." : "");
				if (attachmentPaths.length > 0) {
					await Promise.race([liveConnection.clearPreview(), waitForAbort(ctx.signal)]);
					remoteMessageId = await Promise.race([
						liveConnection.sendFinal(pendingPreviewText, attachmentPaths, ctx.signal),
						new Promise<string>((_, reject) =>
							setTimeout(() => reject(new Error("attachment upload timed out")), 120000),
						),
						waitForAbort(ctx.signal),
					]);
				} else {
					const ids = await Promise.race([
						liveConnection.syncPreview(pendingPreviewText, true),
						waitForAbort(ctx.signal),
					]);
					remoteMessageId = ids[0];
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				chatTurnInFlight = false;
				if (error instanceof Error && error.name === "AbortError") {
					await runtime.failActiveJob("aborted");
					updateStatus(ctx);
					await tryDispatch(ctx);
					return;
				}
				await runtime.failActiveJob(`send failed: ${message}`);
				updateStatus(ctx, message);
				await tryDispatch(ctx);
				return;
			}
		}
		chatTurnInFlight = false;
		await runtime.completeActiveJob(pendingPreviewText, remoteMessageId, attachmentPaths);
		updateStatus(ctx);
		await tryDispatch(ctx);
	});
}

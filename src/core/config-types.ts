export type ChatService = "telegram" | "discord";

export type TriggerMode = "mention" | "message";

export interface AccessPolicy {
	trigger?: TriggerMode;
	ignoreBots?: boolean;
	allowedUserIds?: string[];
	allowedRoleIds?: string[];
}

export interface ConfiguredChannel {
	id: string;
	name?: string;
	dm?: boolean;
	access?: AccessPolicy;
}

export interface BaseAccountConfig {
	service: ChatService;
	name?: string;
	access?: AccessPolicy;
	channels: Record<string, ConfiguredChannel>;
}

export interface TelegramAccountConfig extends BaseAccountConfig {
	service: "telegram";
	botToken: string;
	botUsername?: string;
	botUserId?: string;
}

export interface DiscordAccountConfig extends BaseAccountConfig {
	service: "discord";
	botToken: string;
	applicationId: string;
	serverId: string;
	serverName: string;
	botUserId?: string;
	botUsername?: string;
}

export type ChatAccountConfig = TelegramAccountConfig | DiscordAccountConfig;

export interface ChatConfig {
	botName?: string;
	accounts: Record<string, ChatAccountConfig>;
}

export interface ResolvedConversation {
	service: ChatService;
	botName: string;
	accountId: string;
	account: ChatAccountConfig;
	channelKey: string;
	channel: ConfiguredChannel;
	conversationId: string;
	conversationName: string;
	access: AccessPolicy;
	logPath: string;
	filesDir: string;
	lockPath: string;
}

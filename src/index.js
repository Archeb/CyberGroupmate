import TelegramBot from "node-telegram-bot-api";
import { TelegramHandler } from "./handlers/telegramHandler.js";
import { KuukiyomiHandler } from "./handlers/kuukiyomi.js";
import { ActionGenerator } from "./handlers/actionGenerator.js";
import { RAGHelper } from "./helpers/ragHelper.js";
import { BotActionHelper } from "./helpers/botActionHelper.js";
import { VisionHelper } from "./helpers/visionHelper.js";
import { ConfigManager } from "./managers/configManager.js";
import { MCPHelper } from "./helpers/mcpHelper.js";
import config from "./config.js";
import { StickerHelper } from "./helpers/stickerHelper.js";
import { McpZodTypeKind } from "@modelcontextprotocol/sdk/server/completable.js";

// 创建配置管理器
const configManager = new ConfigManager(config);

// 创建bot实例
const bot = new TelegramBot(config.base.telegram.botToken, {
	polling: true,
});

// 创建全局辅助实例
const ragHelper = new RAGHelper(config.base);
const visionHelper = new VisionHelper(config.base, bot, ragHelper);
const stickerHelper = new StickerHelper(config.base, bot);
const botActionHelper = new BotActionHelper(
	config.base,
	bot,
	ragHelper,
	stickerHelper,
	visionHelper
);

// 初始化 MCP Helper
const mcpHelper = new MCPHelper();
let mcpTools = [];

// 如果配置了 MCP 服务器，则连接并获取工具列表
if (config.base.mcp?.servers && Array.isArray(config.base.mcp.servers)) {
	for (const serverConfig of config.base.mcp.servers) {
		try {
			const serverTools = await mcpHelper.connectToServer(serverConfig);
			mcpTools = [...mcpTools, ...serverTools];
		} catch (error) {
			console.error(`Failed to initialize MCP server ${serverConfig.name}:`, error);
		}
	}

	if (mcpTools.length > 0) {
		// 按服务器打印加载的工具
		const toolsByServer = mcpHelper.getToolsByServer();
		console.log("\nLoaded MCP tools by server:");
		for (const [serverName, tools] of Object.entries(toolsByServer)) {
			console.log(`\n${serverName}:`);
			tools.forEach((tool) => {
				console.log(`  - ${tool.function.name}: ${tool.function.description}`);
			});
		}
	}
}

// 聊天状态管理
const chatStates = new Map();

async function getChatState(chatId) {
	if (!chatStates.has(chatId)) {
		let chatConfig = configManager.getChatConfig(chatId);

		if (!chatConfig && config.base.privateChatMode == 2)
			chatConfig = configManager.getBaseConfig(); // 允许所有私聊
		if (
			!chatConfig &&
			config.base.privateChatMode == 1 &&
			(await ragHelper.getUserMemory(chatId))
		)
			chatConfig = configManager.getBaseConfig(); // 允许有记忆的私聊

		if (!chatConfig) return null;

		let kuukiyomiHandler = new KuukiyomiHandler(chatConfig, ragHelper, botActionHelper);
		let actionGenerator = new ActionGenerator(
			chatConfig,
			botActionHelper,
			ragHelper,
			kuukiyomiHandler,
			stickerHelper,
			mcpHelper,
			mcpTools // 传入已初始化的 MCP 工具列表
		);
		let telegramHandler = new TelegramHandler(chatConfig, ragHelper, visionHelper, stickerHelper);

		chatStates.set(chatId, {
			isProcessing: false,
			pendingAction: null,
			// 为每个聊天创建独立的处理器实例
			telegramHandler: telegramHandler,
			actionGenerator: actionGenerator,
			kuukiyomi: kuukiyomiHandler,
		});
	}
	return chatStates.get(chatId);
}

// 错误处理
bot.on("polling_error", (error) => {
	console.error("Polling error:", error);
});

bot.on("error", (error) => {
	console.error("Bot error:", error);
});

// 处理消息
bot.on("message", async (msg) => {
	try {
		const chatState = await getChatState(msg.chat.id);
		if (!chatState) {
			if (config.base.debug) {
				console.log(`未配置的聊天，忽略消息: ${msg.chat.id}`);
			}
			if (msg.chat.type === "private" && config.base.privateChatMode === 1)
				bot.sendMessage(msg.chat.id, "我们还不熟哦，先在群里多聊聊看？");
			return;
		}

		// 使用聊天专属的处理器
		const processedMsg = await chatState.telegramHandler.handleMessage(msg);
		if (!processedMsg) return;

		// 保存消息
		await ragHelper.saveMessage(processedMsg);

		// 获取响应决策
		const responseDecision = await chatState.kuukiyomi.shouldAct(processedMsg);

		if (config.base.debug) console.log("响应决策：", responseDecision);

		if (responseDecision.shouldAct) {
			if (chatState.isProcessing) {
				// 设置新的待处理消息
				chatState.pendingAction = {
					chatId: msg.chat.id,
					messageId: msg.message_id,
					processedMsg,
					responseDecision,
				};
				// 如果当前正在处理消息且在5秒内，尝试中断当前处理
				if (
					chatState.processingStartTime &&
					new Date(processedMsg.metadata.date || Date.now()) -
						chatState.processingStartTime <
						config.base.actionGenerator.interruptTimeout &&
					chatState.interruptCount < config.base.actionGenerator.maxInterruptions &&
					chatState.abortController
				) {
					// 触发中断
					chatState.abortController.abort();
				}
				return;
			} else {
				await processMessage(msg, processedMsg, responseDecision, chatState);
			}
		}
	} catch (error) {
		console.error("消息处理错误:", error);
	}
});

async function processMessage(msg, processedMsg, responseDecision, chatState) {
	try {
		chatState.isProcessing = true;
		chatState.interruptCount = 0; // 初始化重试计数
		chatState.processingStartTime = Date.now(); // 记录开始处理的时间
		if (!chatState.abortController) chatState.abortController = new AbortController();

		while (true) {
			try {
				// 获取上下文
				const [similarMessage, messageContext] = await Promise.all([
					ragHelper.searchSimilarContent(msg.chat.id, processedMsg.text, {
						limit: 10,
						contentTypes: ["note"],
						timeWindow: "7 days",
					}),
					ragHelper.getMessageContext(msg.chat.id, msg.message_id, 25),
				]);

				responseDecision = await chatState.kuukiyomi.consider(
					responseDecision,
					processedMsg
				);
				if (!responseDecision.shouldAct) break;

				await chatState.actionGenerator.generateAction(
					{
						similarMessage,
						messageContext,
						chatId: msg.chat.id,
						responseDecision,
					},
					chatState
				);
				break; // 成功完成，退出循环
			} catch (error) {
				if (
					error.message === "AbortError" &&
					chatState.interruptCount < config.base.actionGenerator.maxInterruptions
				) {
					chatState.interruptCount++;
					chatState.abortController = null;
					console.log(`处理被中断，开始第 ${chatState.interruptCount} 次重试`);
					continue;
				}
				throw error; // 其他错误或超过重试次数，抛出错误
			} finally {
				// 确保每次循环都会清理控制器
				chatState.abortController = null;
			}
		}
	} finally {
		chatState.isProcessing = false;
		chatState.processingStartTime = null;

		// 处理完成后，如果还有待处理的消息，则处理该消息
		if (chatState.pendingAction) {
			const { chatId, messageId, processedMsg, responseDecision } = chatState.pendingAction;
			chatState.pendingAction = null;
			await processMessage(
				{ chat: { id: chatId }, message_id: messageId },
				processedMsg,
				responseDecision,
				chatState
			);
		}
	}
}

// 处理消息编辑
bot.on("edited_message", async (msg) => {
	try {
		const chatState = await getChatState(msg.chat.id);
		if (!chatState) {
			if (config.base.debug) {
				console.log(`未配置的聊天，忽略编辑消息: ${msg.chat.id}`);
			}
			return;
		}

		const processedMsg = await chatState.telegramHandler.handleMessage(msg);
		if (!processedMsg) return;

		await ragHelper.updateMessage(processedMsg);
	} catch (error) {
		console.error("编辑消息处理错误:", error);
	}
});

// 优雅退出时断开 MCP 连接
process.on("SIGINT", async () => {
	console.log("正在关闭机器人...");
	await mcpHelper.disconnect();
	bot.stopPolling();
	process.exit(0);
});

console.log("机器人已启动");

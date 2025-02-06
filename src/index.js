import TelegramBot from "node-telegram-bot-api";
import { TelegramHandler } from "./handlers/telegramHandler.js";
import { KuukiyomiHandler } from "./handlers/kuukiyomi.js";
import { LLMHandler } from "./handlers/llmHandler.js";
import { RAGHelper } from "./helpers/ragHelper.js";
import { BotActionHelper } from "./helpers/botActionHelper.js";
import { VisionHelper } from "./helpers/visionHelper.js";
import { ConfigManager } from "./managers/configManager.js";
import config from "./config.js";
import { StickerHelper } from "./helpers/stickerHelper.js";

// 创建配置管理器
const configManager = new ConfigManager(config);

// 创建bot实例
const bot = new TelegramBot(config.base.telegram.botToken, {
	polling: true,
});

// 聊天状态管理
const chatStates = new Map();

function getChatState(chatId) {
	if (!chatStates.has(chatId)) {
		const chatConfig = configManager.getChatConfig(chatId);
		if (!chatConfig) return null;

		let kuukiyomiHandler = new KuukiyomiHandler(chatConfig);
		let llmHandler = new LLMHandler(
			chatConfig,
			botActionHelper,
			ragHelper,
			kuukiyomiHandler,
			stickerHelper
		);
		let telegramHandler = new TelegramHandler(chatConfig, ragHelper, visionHelper);

		chatStates.set(chatId, {
			isProcessing: false,
			pendingAction: null,
			// 为每个聊天创建独立的处理器实例
			telegramHandler: telegramHandler,
			llmHandler: llmHandler,
			kuukiyomi: kuukiyomiHandler,
		});
	}
	return chatStates.get(chatId);
}

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
		const chatState = getChatState(msg.chat.id);
		if (!chatState) {
			if (config.base.debug) {
				console.log(`未配置的聊天，忽略消息: ${msg.chat.id}`);
			}
			return;
		}

		// 使用聊天专属的处理器
		const processedMsg = await chatState.telegramHandler.handleMessage(msg);
		if (!processedMsg) return;

		// 保存消息
		await ragHelper.saveMessage(processedMsg);

		// 获取响应决策
		const responseDecision = chatState.kuukiyomi.shouldAct(processedMsg);

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
					chatState.retryCount < config.base.actionGenerator.maxRetryCount &&
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

// 修改消息处理函数以使用 chatState
async function processMessage(msg, processedMsg, responseDecision, chatState) {
	try {
		chatState.isProcessing = true;
		chatState.retryCount = 0; // 初始化重试计数
		chatState.processingStartTime = Date.now(); // 记录开始处理的时间

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

				await chatState.llmHandler.generateAction(
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
					chatState.retryCount < config.base.actionGenerator.maxRetryCount
				) {
					chatState.retryCount++;
					console.log(`处理被中断，开始第 ${chatState.retryCount} 次重试`);
					continue;
				}
				throw error; // 其他错误或超过重试次数，抛出错误
			}
		}
	} finally {
		chatState.isProcessing = false;
		chatState.abortController = null;
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
		const chatState = getChatState(msg.chat.id);
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

// 优雅退出
process.on("SIGINT", () => {
	console.log("正在关闭机器人...");
	bot.stopPolling();
	process.exit(0);
});

console.log("机器人已启动");

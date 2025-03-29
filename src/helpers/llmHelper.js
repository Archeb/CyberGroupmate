import OpenAI from "openai";
import * as fs from "fs/promises";
import * as path from "path";

export class LLMHelper {
	constructor(chatConfig, botActionHelper) {
		this.chatConfig = chatConfig;
		this.currentBackendIndex = 0; // 轮询索引
		this.botActionHelper = botActionHelper;
	}

	/**
	 * 调用LLM API
	 */
	async callLLM(messages, signal, backend, maxRetries = 3, tools = null) {
		let lastError;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				// 轮询选择backend配置
				const backendConfig = backend[this.currentBackendIndex % backend.length];

				// 使用选中的backend配置初始化OpenAI客户端
				let openai = new OpenAI({
					apiKey: backendConfig.apiKey,
					baseURL: backendConfig.baseURL,
				});

				// o3/o1 兼容
				const maxTokensParam =
					backendConfig.model.startsWith("o3") || backendConfig.model.startsWith("o1")
						? "max_completion_tokens"
						: "max_tokens";

				const completionParams = {
					model: backendConfig.model,
					messages: messages,
					[maxTokensParam]: backendConfig.maxTokens,
				};

				// 如果提供了tools，添加tools相关参数
				if (tools) {
					completionParams.tools = tools;
					completionParams.tool_choice = "auto";
				}

				if (
					!(backendConfig.model.startsWith("o3") || backendConfig.model.startsWith("o1"))
				) {
					completionParams.temperature = backendConfig.temperature;
				}

				let completion = await openai.chat.completions.create(completionParams, {
					signal: signal || undefined,
				});

				this.currentBackendIndex++; // 递增索引

				if (typeof completion === "string") completion = JSON.parse(completion);

				if (this.chatConfig.debug) {
					// 保存日志到文件
					let timestamp = new Date().toISOString().replace(/[:.]/g, "-");
					let logContent = [
						// 输入消息
						messages.map((msg) => `--- ${msg.role} ---\n${msg.content}\n`).join("\n"),
						// 分隔线
						"\n=== Response ===\n",
						// 响应内容
						JSON.stringify(completion.choices[0], null, 2),
						// 模型
						`model: ${backendConfig.model}`,
					].join("\n");

					// 确保logs目录存在
					await fs.mkdir("logs", { recursive: true });

					// 写入日志文件
					await fs.writeFile(path.join("logs", `${timestamp}.txt`), logContent, "utf-8");
				}

				// 保存碎碎念
				if (this.chatConfig.memoChannelId && this.chatConfig.enableMemo) {
					this.botActionHelper.sendText(
						this.chatConfig.memoChannelId,
						[
							"response:",
							JSON.stringify(completion.choices[0], null, 2),
							"model:",
							backendConfig.model,
						].join("\n"),
						false,
						false
					);
				}

				if (this.chatConfig.debug) console.log(completion.choices[0]);

				return completion.choices[0];
			} catch (error) {
				if (error.message === "Request was aborted.") {
					throw new Error("AbortError");
				}

				lastError = error;
				this.currentBackendIndex++; // 失败时也递增索引，切换到下一个后端

				// 如果这是最后一次尝试，则抛出错误
				if (attempt === maxRetries - 1) {
					throw new Error(`所有重试都失败。最后一次错误: ${lastError.message}`);
				}

				// 如果还有重试机会，则继续下一次循环
				if (this.chatConfig.debug) {
					console.log(error);
					console.log(`第 ${attempt + 1} 次调用失败，切换后端重试...`);
				}

				// 可以添加一个小延迟，避免立即重试
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	}

	/**
	 * 获取消息历史并格式化为LLM消息格式
	 */
	processMessageHistory(messageContext, withDate = false, emphasizeRepliedMessage = false) {
		let history = messageContext;

		// 寻找出历史消息里面所有content_type为reply的消息并且添加到bot_replied_message_id中
		let repliedMessageIds = [];
		history.forEach((item) => {
			if (item.content_type === "reply" && item.metadata?.reply_to_message_id) {
				repliedMessageIds.push(item.metadata.reply_to_message_id);
			}
		});

		let textHistory = history.map((item) => {
			// 计算时间差
			let msgSuffix = "";
			if (withDate && item.created_at) {
				const now = Date.now();
				const createdAt = new Date(item.created_at + "Z"); // 添加Z表示这是UTC时间
				const diff = (now - createdAt.getTime()) / 1000; // 转换为秒

				if (diff < 60) {
					msgSuffix = "刚刚";
				} else if (diff < 3600) {
					msgSuffix = `${Math.floor(diff / 60)}分钟前`;
				} else if (diff < 86400) {
					msgSuffix = `${Math.floor(diff / 3600)}小时前`;
				} else {
					msgSuffix = `${Math.floor(diff / 86400)}天前`;
				}
				msgSuffix = ` (${msgSuffix})`;
			}

			// 如果是回复消息，强调回复的消息
			if (emphasizeRepliedMessage && repliedMessageIds.includes(item.message_id)) {
				msgSuffix += " (已回复过)";
			}

			// 根据内容类型处理不同的格式
			if (item.content_type === "message") {
				let metadata = item.metadata || {};
				let userIdentifier = `${metadata.from.first_name || ""}${metadata.from.last_name || ""}`;

				// 检查用户是否在黑名单中
				if (this.chatConfig.blacklistUsers?.includes(metadata.from.id)) {
					return "";
				}

				// 转义 < 和 > 字符
				item.text = item.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");

				// 处理回复消息
				if (metadata.reply_to_message) {
					let replyMeta = metadata.reply_to_message;
					let replyUserIdentifier = `${replyMeta.from.first_name || ""}${replyMeta.from.last_name || ""}`;

					// 检查回复的消息ID是否在当前上下文中
					const isReplyInContext = history.some(
						(msg) => msg.message_id == replyMeta.message_id
					);

					const replyContent = isReplyInContext
						? ""
						: `${replyMeta.text || "[媒体内容]"}`;

					return `<message id="${item.message_id}" user="${userIdentifier}" userid="${replyMeta.from.id}"${msgSuffix}><reply_to user="${replyUserIdentifier}">${replyContent}</reply_to>${item.text}</message>`;
				} else {
					return `<message id="${item.message_id}" user="${userIdentifier}" userid="${metadata.from.id}"${msgSuffix}>${item.text}</message>`;
				}
			} else {
				return `<bot_${item.content_type}${msgSuffix}>${item.text}</bot_${item.content_type}>`;
			}
		});

		return textHistory.join("\n");
	}
}

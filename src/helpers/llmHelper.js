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
	async callLLM(messages, signal) {
		let lastError;

		for (let attempt = 0; attempt < this.chatConfig.actionGenerator.maxRetries; attempt++) {
			try {
				// 轮询选择backend配置
				const backends = this.chatConfig.actionGenerator.backend;
				const backendConfig = backends[this.currentBackendIndex % backends.length];

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
					[maxTokensParam]: backendConfig.maxTokens, // 使用动态参数名
				};

				if (
					!(backendConfig.model.startsWith("o3") || backendConfig.model.startsWith("o1"))
				) {
					completionParams.temperature = backendConfig.temperature;
				}

				let completion = await openai.chat.completions.create(completionParams, {
					signal: signal,
				});

				this.currentBackendIndex++; // 递增索引

				if (typeof completion === "string") completion = JSON.parse(completion);

				// 合并reasoning和content
				let response =
					(completion.choices[0].message?.reasoning ||
						completion.choices[0].message?.reasoning_content ||
						"") + completion.choices[0].message?.content || "";

				if (this.chatConfig.debug) {
					// 保存日志到文件
					let timestamp = new Date().toISOString().replace(/[:.]/g, "-");
					let logContent = [
						// 输入消息
						messages.map((msg) => `--- ${msg.role} ---\n${msg.content}\n`).join("\n"),
						// 分隔线
						"\n=== Response ===\n",
						// 响应内容
						response,
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
						["response:", response, "model:", backendConfig.model].join("\n"),
						false,
						false
					);
				}

				if (this.chatConfig.debug) console.log(response);

				return response;
			} catch (error) {
				if (error.message === "Request was aborted.") {
					throw new Error("AbortError");
				}

				lastError = error;
				this.currentBackendIndex++; // 失败时也递增索引，切换到下一个后端

				// 如果这是最后一次尝试，则抛出错误
				if (attempt === this.chatConfig.actionGenerator.maxRetries - 1) {
					throw new Error(`所有重试都失败。最后一次错误: ${lastError.message}`);
				}

				// 如果还有重试机会，则继续下一次循环
				if (this.chatConfig.debug) {
					console.log(`第 ${attempt + 1} 次调用失败，切换后端重试...`);
				}

				// 可以添加一个小延迟，避免立即重试
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	}

	/**
	 * 从LLM响应中提取函数调用
	 */
	extractFunctionCalls(response, supportedFunctions, multiShotFunctions) {
		// 如果内容为空，返回空数组
		if (!response) {
			return { functionCalls: [], response: "" };
		}

		let functionCalls = [];

		// 创建匹配所有支持函数的统一正则表达式
		let combinedRegex = new RegExp(
			`<(${supportedFunctions.join("|")})>([\\s\\S]*?)<\\/\\1>`,
			"g"
		);

		let match;
		let lastIndex = 0;
		let foundMultiShot = false;

		while ((match = combinedRegex.exec(response)) !== null) {
			let funcName = match[1];
			let params = match[2].trim();

			try {
				// 检查是否是multiShot函数
				if (multiShotFunctions.includes(funcName)) {
					foundMultiShot = true;
					lastIndex = match.index + match[0].length;
				}

				// 如果已经找到multiShot函数，则不再处理后续函数
				if (foundMultiShot && !multiShotFunctions.includes(funcName)) {
					continue;
				}

				// 对于skip函数，不需要参数
				if (funcName === "chat_skip") {
					functionCalls.push({
						function: funcName,
						params: {},
					});
					continue;
				}

				// 解析其他函数的参数
				let parsedParams = {};
				// 使用正则表达式匹配HTML标签
				const tagRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
				let paramMatch;

				while ((paramMatch = tagRegex.exec(params)) !== null) {
					const [_, key, value] = paramMatch;
					// 移除多余的空白字符
					parsedParams[key] = value.trim();
				}

				functionCalls.push({
					function: funcName,
					params: parsedParams,
				});

				// 如果是multiShot函数，立即停止处理后续内容
				if (multiShotFunctions.includes(funcName)) {
					break;
				}
			} catch (error) {
				console.error(`处理函数 ${funcName} 时出错:`, error);
			}
		}

		// 如果找到了multiShot函数，清空该函数后的所有内容
		if (foundMultiShot && lastIndex > 0) {
			response = response.substring(0, lastIndex);
		}

		return { functionCalls, response };
	}

	/**
	 * 获取消息历史并格式化为LLM消息格式
	 */
	processMessageHistory(messageContext, withDate = false, emphasizeLastReply = false) {
		let history = messageContext;
		let textHistory = history.map((item) => {
			// 计算时间差
			let timeStr = "";
			if (withDate && item.created_at) {
				const now = Date.now();
				const createdAt = new Date(item.created_at + "Z"); // 添加Z表示这是UTC时间
				const diff = (now - createdAt.getTime()) / 1000; // 转换为秒

				if (diff < 60) {
					timeStr = "刚刚";
				} else if (diff < 3600) {
					timeStr = `${Math.floor(diff / 60)}分钟前`;
				} else if (diff < 86400) {
					timeStr = `${Math.floor(diff / 3600)}小时前`;
				} else {
					timeStr = `${Math.floor(diff / 86400)}天前`;
				}
				timeStr = ` (${timeStr})`;
			}

			// 根据内容类型处理不同的格式
			if (item.content_type === "message") {
				let metadata = item.metadata || {};
				let userIdentifier = `${metadata.from.first_name || ""}${metadata.from.last_name || ""}`;

				// 检查用户是否在黑名单中
				if (this.chatConfig.blacklistUsers?.includes(metadata.from.id)) {
					return "";
				}

				// 处理回复消息
				if (metadata.reply_to_message) {
					let replyMeta = metadata.reply_to_message;
					let replyUserIdentifier = `${replyMeta.from.first_name || ""}${replyMeta.from.last_name || ""}`;
					return `<message id="${item.message_id}" user="${userIdentifier}"${timeStr}><reply_to user="${replyUserIdentifier}">${replyMeta.text || "[媒体内容]"}</reply_to>${item.text}</message>`;
				} else {
					return `<message id="${item.message_id}" user="${userIdentifier}"${timeStr}>${item.text}</message>`;
				}
			} else {
				// 处理bot的actions (note, reply, search等)
				// 如果是最后一条消息且是bot reply,则改为bot_latest_reply
				if (
					item.content_type === "reply" &&
					history.indexOf(item) === history.length - 1 &&
					emphasizeLastReply
				) {
					return `<bot_latest_reply${timeStr}>${item.text}</bot_latest_reply>`;
				}
				return `<bot_${item.content_type}${timeStr}>${item.text}</bot_${item.content_type}>`;
			}
		});

		return textHistory.join("\n");
	}
}

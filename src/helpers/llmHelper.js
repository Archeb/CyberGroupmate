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

				// 处理Gemini API的特殊情况：将Python代码转换为tool calls
				let processedChoice = this.processGeminiResponse(completion.choices[0]);

				if (this.chatConfig.debug) {
					// 保存日志到文件
					let timestamp = new Date().toISOString().replace(/[:.]/g, "-");
					let logContent = [
						// 输入消息
						messages.map((msg) => `--- ${msg.role} ---\n${msg.content}\n`).join("\n"),
						// 分隔线
						"\n=== Response ===\n",
						// 响应内容
						JSON.stringify(processedChoice, null, 2),
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
							JSON.stringify(processedChoice, null, 2),
							"model:",
							backendConfig.model,
						].join("\n"),
						false,
						false
					);
				}

				if (this.chatConfig.debug) console.log(processedChoice);

				return processedChoice;
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
	/**
	 * 解析Python代码块中的函数调用并转换为tool calls
	 */
	parsePythonCodeToToolCalls(content) {
		// 查找markdown代码块
		const codeBlockRegex = /```(?:python)?\s*([\s\S]*?)```\s*$/;
		const match = content.match(codeBlockRegex);
		
		if (!match) {
			return null;
		}
 
		const pythonCode = match[1].trim();
		const toolCalls = [];
 
		// 匹配print()函数内的API调用
		// 支持多行和单行格式
		const printRegex = /print\s*\(\s*([\s\S]*?\))\s*\)/g;
		
		let printMatch;
		let callIndex = 0;
		
		while ((printMatch = printRegex.exec(pythonCode)) !== null) {
			const printContent = printMatch[1];
			
			// 在print内容中查找API调用 (object.method格式)
			const apiCallRegex = /(\w+)\.(\w+)\s*\(\s*(.*?)\s*\)/;
			const apiMatch = printContent.match(apiCallRegex);
			
			if (apiMatch) {
				const [, objectName, methodName, argsString] = apiMatch;
				
				try {
					// 解析参数
					const args = this.parsePythonArguments(argsString);
					
					// 构造tool call
					const toolCall = {
						id: `call_${Date.now()}_${callIndex}`,
						type: "function",
						function: {
							name: methodName, // 只使用方法名，不包含对象名
							arguments: JSON.stringify(args)
						}
					};
					
					toolCalls.push(toolCall);
					callIndex++;
				} catch (error) {
					if (this.chatConfig.debug) {
						console.log(`解析API调用失败: ${apiMatch[0]}, 错误: ${error.message}`);
					}
				}
			}
		}
 
		return toolCalls.length > 0 ? toolCalls : null;
	}
 
	/**
	 * 解析Python函数参数
	 */
	parsePythonArguments(argsString) {
		if (!argsString.trim()) {
			return {};
		}
 
		const args = {};
		
		// 简单的参数解析，支持 key=value 格式
		const argPairs = this.splitArguments(argsString);
		
		for (const pair of argPairs) {
			const equalIndex = pair.indexOf('=');
			if (equalIndex > 0) {
				const key = pair.substring(0, equalIndex).trim();
				let value = pair.substring(equalIndex + 1).trim();
				
				// 移除引号并解析值
				if ((value.startsWith('"') && value.endsWith('"')) || 
					(value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1);
				} else if (!isNaN(value)) {
					value = Number(value);
				} else if (value === 'True') {
					value = true;
				} else if (value === 'False') {
					value = false;
				} else if (value === 'None') {
					value = null;
				}
				
				args[key] = value;
			}
		}
		
		return args;
	}
 
	/**
	 * 分割函数参数，处理嵌套的引号和括号
	 */
	splitArguments(argsString) {
		const args = [];
		let current = '';
		let inQuotes = false;
		let quoteChar = '';
		let parenDepth = 0;
		
		for (let i = 0; i < argsString.length; i++) {
			const char = argsString[i];
			
			if (!inQuotes && (char === '"' || char === "'")) {
				inQuotes = true;
				quoteChar = char;
				current += char;
			} else if (inQuotes && char === quoteChar) {
				inQuotes = false;
				current += char;
			} else if (!inQuotes && char === '(') {
				parenDepth++;
				current += char;
			} else if (!inQuotes && char === ')') {
				parenDepth--;
				current += char;
			} else if (!inQuotes && char === ',' && parenDepth === 0) {
				args.push(current.trim());
				current = '';
			} else {
				current += char;
			}
		}
		
		if (current.trim()) {
			args.push(current.trim());
		}
		
		return args;
	}
 
	/**
	 * 处理Gemini API的Python代码转换
	 */
	processGeminiResponse(choice) {
		if (!choice.message || !choice.message.content) {
			return choice;
		}
 
		const content = choice.message.content;
		const toolCalls = this.parsePythonCodeToToolCalls(content);
		
		if (toolCalls) {
			// 移除代码块，保留其他内容
			const codeBlockRegex = /```(?:python)?\s*([\s\S]*?)```\s*$/;
			const cleanContent = content.replace(codeBlockRegex, '').trim();
			
			// 创建新的choice对象
			const newChoice = {
				...choice,
				message: {
					...choice.message,
					content: cleanContent || null,
					tool_calls: toolCalls
				}
			};
			
			if (this.chatConfig.debug) {
				console.log('检测到Python代码，转换为tool calls:', toolCalls);
			}
			
			return newChoice;
		}
		
		return choice;
	}
}

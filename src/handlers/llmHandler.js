import OpenAI from "openai";
import * as fs from "fs/promises";
import * as path from "path";

export class LLMHandler {
	constructor(chatConfig = {}, botActionHelper, ragHelper, kuukiyomiHandler, stickerHelper) {
		this.chatConfig = chatConfig;
		this.currentBackendIndex = 0; // 轮询索引

		this.botActionHelper = botActionHelper;
		this.ragHelper = ragHelper;
		this.kuukiyomiHandler = kuukiyomiHandler;
		this.stickerHelper = stickerHelper;
	}

	/**
	 * 生成行动
	 */
	async generateAction(context, chatState) {
		try {
			// 准备prompt
			let messages = await this.prepareMessages(context);

			// 调用API（传递signal）
			let response = await this.callLLM(
				messages,
				context,
				chatState?.abortController?.signal
			);

			// 如果已经被中断，直接返回
			if (chatState?.abortController?.signal.aborted) {
				throw new Error("AbortError");
			}

			// 处理响应
			await this.processResponse(response, context);

			return response;
		} catch (error) {
			if (error.name === "AbortError" || error.message === "AbortError") {
				throw error; // 将 AbortError 抛出，让上层处理重试逻辑
			}
			console.error("生成行动出错:", error);
			throw error;
		}
	}

	/**
	 * 获取消息历史并格式化为LLM消息格式
	 */
	processMessageHistoryForLLM(messageContext, withDate = false, emphasizeLastReply = false) {
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

	/**
	 * 准备发送给LLM的消息
	 */
	async prepareMessages(context, multiShotPrompt = "") {
		// 添加系统提示词，这里用system role
		let messages = [
			{
				role: "system",
				content:
					this.chatConfig.actionGenerator.systemPrompt +
					`<facts>
现在的时间是${new Date().toLocaleString("zh-CN", { timeZone: this.chatConfig.actionGenerator.timeZone })}
当前唤起场景为${context.responseDecision.scene}。
</facts>`,
			},
		];

		//从这里开始用 user role，所有消息先用回车分隔，最后再合并到 user role message 里
		let userRoleMessages = [];

		// 添加近似RAG搜索结果，
		if (context.similarMessage) {
			userRoleMessages.push(
				"<related_notes>\n" +
					this.processMessageHistoryForLLM(context.similarMessage, true) +
					"\n</related_notes>"
			);
		}

		// 添加历史消息
		userRoleMessages.push(
			"<chat_history>\n" +
				this.processMessageHistoryForLLM(context.messageContext, true, true) +
				"\n</chat_history>"
		);

		// 在添加历史消息之后，添加用户记忆
		if (["private", "mention", "trigger"].includes(context.responseDecision.decisionType)) {
			// 获取最后一条消息的用户信息
			const lastMessage = context.messageContext[context.messageContext.length - 1];
			if (lastMessage?.metadata?.from?.id && lastMessage.content_type === "message") {
				const userMemories = await this.ragHelper.getUserMemory(
					lastMessage.metadata.from.id
				);
				if (userMemories) {
					userRoleMessages.push(
						`<user_memories for="${lastMessage.metadata.from.first_name || ""}${lastMessage.metadata.from.last_name || ""}">` +
							userMemories.text +
							"\n</user_memories>"
					);
				}
			}
		}

		// 添加可用函数
		userRoleMessages.push(
			`<function>你可以使用以下函数和参数，一次可以调用多个函数，列表如下：`
		);
		if (context.responseDecision.decisionType == "trigger") {
			userRoleMessages.push(`# 跳过（无参数）
<chat_skip>
</chat_skip>`);
		}
		userRoleMessages.push(`
# 直接向群内发送消息
<chat_text>
<message>要发送的内容</message>
</chat_text>

# 回复某一条消息
<chat_reply>
<message_id>要回复的消息ID</message_id>
<message>要发送的内容</message>
</chat_reply>

# 群聊笔记，用符合心情的语气记录
<chat_note>
<note>要记录的内容</note>
</chat_note> 

# 使用语义检索聊天历史
<chat_search>
<keyword>要搜索的多个关键词</keyword>
</chat_search>

# 更新用户记忆
<user_memories>
<message_id>该用户的相关消息ID</message_id>
<memories>要更新或者添加的长期记忆内容</memories>
</user_memories>

# 使用谷歌搜索互联网
<web_search>
<keyword>要搜索的多个关键词</keyword>
</web_search>
</function>

# 根据URL获取内容
<web_getcontent>
<url>要访问的url</url>
</web_getcontent>
</function>
`);
		userRoleMessages.push(`<available_stickers>
偶尔可以在你的回复中包含以下 emoji 来发送贴纸（最多1个，不能用其它的）：
${this.stickerHelper.getAvailableEmojis().join(",")}
</available_stickers>`);

		// 添加任务
		userRoleMessages.push(this.chatConfig.actionGenerator.taskPrompt);
		if (multiShotPrompt) {
			userRoleMessages.push(multiShotPrompt);
		}
		// 添加越狱
		userRoleMessages.push(this.chatConfig.actionGenerator.jailbreakPrompt);

		// 将所有用户消息合并
		messages.push({ role: "user", content: userRoleMessages.join("\n") });

		return messages;
	}

	/**
	 * 调用LLM API
	 */
	async callLLM(messages, context, signal) {
		this.chatState = context;

		// 轮询选择backend配置
		const backends = this.chatConfig.actionGenerator.backend;
		const backendConfig = backends[this.currentBackendIndex % backends.length];

		// 使用选中的backend配置初始化OpenAI客户端
		let openai = new OpenAI({
			apiKey: backendConfig.apiKey,
			baseURL: backendConfig.baseURL,
		});

		try {
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

			if (!(backendConfig.model.startsWith("o3") || backendConfig.model.startsWith("o1"))) {
				completionParams.temperature = backendConfig.temperature;
			}

			let completion = await openai.chat.completions.create(
				{
					model: backendConfig.model,
					messages: messages,
					[maxTokensParam]: backendConfig.maxTokens, // 使用动态参数名
				},
				{
					signal: signal,
				}
			);

			this.currentBackendIndex++; // 递增索引

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
			throw error;
		}
	}

	/**
	 * 处理LLM的响应
	 */
	async processResponse(response, context) {
		// 计算当前调用深度
		context.StackDepth = context?.StackDepth + 1 || 0;

		if (!response) return;

		try {
			let extractResult = this.extractFunctionCalls(response);
			let functionCalls = extractResult.functionCalls;
			response = extractResult.response;

			for (let call of functionCalls) {
				let { function: funcName, params } = call;

				// 检查是否已被中断
				if (context.signal?.aborted) {
					throw new Error("AbortError");
				}

				switch (funcName) {
					case "chat_skip":
						if (this.chatConfig.debug) console.log("跳过");
						await this.botActionHelper.saveAction(context.chatId, "", "skip");
						// 减少响应率
						this.kuukiyomiHandler.decreaseResponseRate(0.2);
						break;

					case "chat_reply":
						if (!params.message_id || !params.message) {
							console.warn(params);
							console.warn("回复消息缺少必要参数");
							continue;
						}
						// 使用新方法检查重复
						if (this._checkMessageDuplicate(params.message, context)) {
							if (this.chatConfig.debug) console.log("跳过相似回复:", params.message);
							continue;
						}
						await this.botActionHelper.sendReply(
							context.chatId,
							params.message,
							params.message_id
						);
						this.kuukiyomiHandler.increaseResponseRate(0.1);
						break;

					case "chat_text":
						if (!params.message) {
							console.warn("发送消息缺少内容参数");
							continue;
						}
						// 使用新方法检查重复
						if (this._checkMessageDuplicate(params.message, context)) {
							if (this.chatConfig.debug) console.log("跳过相似消息:", params.message);
							continue;
						}
						await this.botActionHelper.sendText(context.chatId, params.message);
						break;

					case "chat_note":
						if (!params.note) {
							console.warn("记录笔记缺少必要参数");
							continue;
						}
						await this.botActionHelper.saveAction(context.chatId, params.note, "note");
						break;

					case "chat_search":
						if (!params.keyword) {
							console.warn("搜索缺少关键词参数");
							continue;
						}
						if (context.StackDepth > this.chatConfig.actionGenerator.maxStackDepth) {
							console.warn("StackDepth超过最大深度，禁止调用可能嵌套的函数");
							continue;
						}
						let result = await this.botActionHelper.search(
							context.chatId,
							params.keyword
						);
						if (this.chatConfig.debug) console.log("history搜索结果：", result);
						context.messageContext.push({
							content_type: "chat_search_called",
							text: `<keyword>${params.keyword}</keyword>`,
						});
						await this.handleRAGSearchResults(result, response, context);
						break;
					case "web_search":
						if (!params.keyword) {
							console.warn("搜索缺少关键词参数");
							continue;
						}
						if (context.StackDepth > this.chatConfig.actionGenerator.maxStackDepth) {
							console.warn("StackDepth超过最大深度，禁止调用可能嵌套的函数");
							continue;
						}
						let webResult = await this.botActionHelper.googleSearch(params.keyword);
						if (this.chatConfig.debug) console.log("web搜索结果：", webResult);
						context.messageContext.push({
							content_type: "web_search_called",
							text: `<keyword>${params.keyword}</keyword>`,
						});
						await this.handleGoogleSearchResults(webResult, response, context);
						break;

					case "web_getcontent":
						if (!params.url) {
							console.warn("访问网页缺少URL参数");
							continue;
						}
						if (context.StackDepth > this.chatConfig.actionGenerator.maxStackDepth) {
							console.warn("StackDepth超过最大深度，禁止调用可能嵌套的函数");
							continue;
						}
						let webContent = await this.botActionHelper.openURL(params.url);
						if (this.chatConfig.debug) console.log("打开网页结果", webContent);
						context.messageContext.push({
							content_type: "web_getcontent_called",
							text: `<url>${params.url}</url>`,
						});
						await this.handleWebContent(webContent, response, context);
						break;

					case "user_memories":
						if (!params.message_id || !params.memories) {
							console.warn("更新用户记忆缺少必要参数");
							continue;
						}
						let memoryResult = await this.botActionHelper.updateMemory(
							params.message_id,
							params.memories
						);
						if (this.chatConfig.debug) {
							console.log("更新用户记忆结果：", memoryResult);
						}
						break;
				}
			}
		} catch (error) {
			if (error.name === "AbortError" || error.message === "AbortError") {
				throw error;
			}
			console.error("处理响应出错:", error);
			throw error;
		}
	}

	/**
	 * 从LLM响应中提取函数调用
	 */
	extractFunctionCalls(response) {
		// 如果内容为空，返回空数组
		if (!response) {
			return { functionCalls: [], response: "" };
		}

		let functionCalls = [];

		// 定义multiShot函数列表
		const multiShotFunctions = ["chat_search", "web_search", "web_getcontent"];

		// 创建匹配所有支持函数的统一正则表达式
		let supportedFunctions = [
			"chat_search",
			"chat_text",
			"chat_reply",
			"chat_note",
			"chat_skip",
			"web_search",
			"web_getcontent",
			"user_memories",
		];
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
	 * 处理历史搜索结果
	 */
	async handleRAGSearchResults(searchResults, previousResponse, context) {
		context.similarMessage = "";
		let botActionResult = this.processMessageHistoryForLLM(searchResults, true);
		context.messageContext.push({
			content_type: "chat_search_result",
			text: botActionResult,
		});
		let messages = await this.prepareMessages(context);
		let newResponse = await this.callLLM(messages, context);
		return this.processResponse(newResponse, context);
	}

	/**
	 * 处理谷歌搜索结果
	 */
	async handleGoogleSearchResults(searchResults, previousResponse, context) {
		context.similarMessage = "";
		let botActionResult;
		for (let item of searchResults) {
			botActionResult += `<title>${item.title}</title>
<url>${item.link}</url>
<snippet>${item.snippet}</snippet>
`;
		}

		context.messageContext.push({
			content_type: "web_search_result",
			text: botActionResult,
		});
		let multiShotPrompt = "<tips>可以考虑是否需要进一步打开谷歌搜索结果URL</tips>";
		let messages = await this.prepareMessages(context, multiShotPrompt);
		let newResponse = await this.callLLM(messages, context);
		return this.processResponse(newResponse, context);
	}

	/**
	 * 处理网页打开结果
	 */
	async handleWebContent(webContent, previousResponse, context) {
		context.similarMessage = "";
		let botActionResult;
		if (webContent.success) {
			botActionResult = `
<title>${webContent.title}</title>
<content>
${webContent.content}
${webContent.truncated ? "网页内容超长被截断" : ""}
</content>
`;
		} else {
			botActionResult = `URL打开失败`;
		}
		context.messageContext.push({
			content_type: "web_open_result",
			text: botActionResult,
		});
		let messages = await this.prepareMessages(context);
		let newResponse = await this.callLLM(messages, context);
		return this.processResponse(newResponse, context);
	}

	/**
	 * 检查消息是否重复（新增方法）
	 * @param {string} message 待检查的消息内容
	 * @param {object} context 上下文对象
	 * @param {number} maxAllowedDiff 允许的最大差异字符数（从配置读取）
	 * @returns {boolean} 是否重复
	 */
	_checkMessageDuplicate(message, context) {
		const maxAllowedDiff = this.chatConfig.actionGenerator?.maxAllowedDiff || 0;
		if (message.length < 2) return false; //一个字的比如emoji或者简单的是否回答可以重复

		return context.messageContext.some((item) => {
			if (item.content_type === "reply" || item.content_type === "text") {
				// 完全匹配直接返回true
				if (item.text === message) return true;

				// 计算相似度差异
				const diff = this._getStringDifference(item.text, message);
				return diff <= maxAllowedDiff;
			}
			return false;
		});
	}

	/**
	 * 计算字符串差异（新增辅助方法）
	 * @param {string} str1 字符串1
	 * @param {string} str2 字符串2
	 * @returns {number} 差异字符数量
	 */
	_getStringDifference(str1 = "", str2 = "") {
		const longer = str1.length > str2.length ? str1 : str2;
		const shorter = str1.length > str2.length ? str2 : str1;

		// 基础差异计算（按字符位置比较）
		let diff = Math.abs(longer.length - shorter.length);
		for (let i = 0; i < shorter.length; i++) {
			if (longer[i] !== shorter[i]) diff++;
		}
		return diff;
	}
}

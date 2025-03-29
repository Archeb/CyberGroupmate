import { LLMHelper } from "../helpers/llmHelper.js";

export class ActionGenerator {
	constructor(chatConfig = {}, botActionHelper, ragHelper, kuukiyomiHandler, stickerHelper) {
		this.chatConfig = chatConfig;

		this.botActionHelper = botActionHelper;
		this.llmHelper = new LLMHelper(chatConfig, botActionHelper);
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
			let response = await this.llmHelper.callLLM(
				messages,
				chatState?.abortController?.signal,
				this.chatConfig.actionGenerator.backend,
				this.chatConfig.actionGenerator.maxRetries,
				this.getTools()
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

		// 添加近似RAG搜索结果
		if (context.similarMessage) {
			userRoleMessages.push(
				"<related_notes>\n" +
					this.llmHelper.processMessageHistory(context.similarMessage, true) +
					"\n</related_notes>"
			);
		}

		// 添加关联上下文(如果存在)
		if (context.responseDecision?.relatedContext?.length > 0) {
			userRoleMessages.push(
				"<related_context>\n" +
					context.responseDecision.relatedContext
						.map((item) => `<${item.content_type}>${item.text}</${item.content_type}>`)
						.join("\n") +
					"\n</related_context>"
			);
		}

		// 添加所有相关用户的记忆
		const userIds = new Set();
		context.messageContext.forEach((message) => {
			if (message?.metadata?.from?.id && message.content_type === "message") {
				userIds.add(message.metadata.from.id);
			}
		});

		// 获取并添加每个用户的记忆
		for (const userId of userIds) {
			const userMemories = await this.ragHelper.getUserMemory(userId);
			if (userMemories) {
				// 找到该用户的最后一条消息以获取用户名信息
				const userLastMessage = [...context.messageContext]
					.reverse()
					.find((msg) => msg?.metadata?.from?.id === userId);

				const firstName = userLastMessage?.metadata?.from?.first_name || "";
				const lastName = userLastMessage?.metadata?.from?.last_name || "";

				userRoleMessages.push(
					`<user_memories for="${firstName}${lastName}" userid="${userId}">` +
						userMemories.text +
						"\n</user_memories>"
				);
			}
		}

		// 添加可用贴纸
		userRoleMessages.push(`<available_stickers>
偶尔可以在你的回复末尾中包含以下 emoji 来发送贴纸（最多1个，不能用其它的）：
${this.stickerHelper.getAvailableEmojis().join(",")}
</available_stickers>`);

		// 添加历史消息
		userRoleMessages.push(
			"<chat_history>\n" +
				this.llmHelper.processMessageHistory(context.messageContext, true, true) +
				"\n</chat_history>"
		);

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
	 * 处理LLM的响应
	 */
	async processResponse(response, context) {
		// 计算当前调用深度
		context.StackDepth = context?.StackDepth + 1 || 0;

		if (!response) return;

		try {
			// 处理工具调用
			if (response.message?.tool_calls) {
				let messages = [];
				let needsFollowUp = false;

				// 添加原始对话历史
				messages = [...(await this.prepareMessages(context))];

				// 为每个工具调用创建一个新的消息
				for (const toolCall of response.message.tool_calls) {
					const { name, arguments: args } = toolCall.function;
					const params = JSON.parse(args);

					// 判断是否需要后续对话的工具
					needsFollowUp = needsFollowUp || this._isFollowUpTool(name);

					// 添加 Assistant 的工具调用请求
					messages.push({
						role: "assistant",
						content: response.message.content,
						tool_calls: [toolCall],
					});

					let toolResult;
					try {
						toolResult = await this.executeToolCall(name, params, context);

						// 添加工具调用结果
						messages.push({
							role: "tool",
							content: JSON.stringify(toolResult),
							tool_call_id: toolCall.id,
						});
					} catch (error) {
						// 如果工具调用失败，添加错误信息
						messages.push({
							role: "tool",
							content: JSON.stringify({ error: error.message }),
							tool_call_id: toolCall.id,
						});
						console.error(`工具 ${name} 调用失败:`, error);
						// 如果是需要后续对话的工具调用失败，也需要继续对话
						needsFollowUp = needsFollowUp || this._isFollowUpTool(name);
					}
				}

				// 只有在需要后续对话且未达到最大深度时才继续对话
				if (
					needsFollowUp &&
					context.StackDepth < this.chatConfig.actionGenerator.maxStackDepth
				) {
					// 如果接近最大调用深度，添加提示信息
					if (context.StackDepth >= this.chatConfig.actionGenerator.maxStackDepth - 1) {
						messages.push({
							role: "system",
							content: "即将达到最大对话深度，请尽快总结当前结果并结束对话。",
						});
					}

					// 调用 LLM 继续对话
					let newResponse = await this.llmHelper.callLLM(
						messages,
						context?.abortController?.signal,
						this.chatConfig.actionGenerator.backend,
						this.chatConfig.actionGenerator.maxRetries,
						this.getTools()
					);

					return this.processResponse(newResponse, context);
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
	 * 判断工具是否需要后续对话
	 * @param {string} toolName 工具名称
	 * @returns {boolean} 是否需要后续对话
	 */
	_isFollowUpTool(toolName) {
		// 定义需要后续对话的工具列表
		const followUpTools = new Set(["chat_search", "web_search", "web_getcontent"]);
		return followUpTools.has(toolName);
	}

	/**
	 * 执行单个工具调用
	 */
	async executeToolCall(name, params, context) {
		switch (name) {
			case "chat_skip":
				if (this.chatConfig.debug) console.log("跳过");
				await this.botActionHelper.saveAction(context.chatId, "", "skip");
				this.kuukiyomiHandler.decreaseResponseRate(0.2);
				return { status: "success", action: "skip" };

			case "chat_reply":
				if (!params.message_id || !params.message) {
					throw new Error("回复消息缺少必要参数");
				}
				if (this._checkMessageDuplicate(params.message, context)) {
					throw new Error("检测到重复消息");
				}
				params.message = this.processSendMessage(params.message);
				await this.botActionHelper.sendReply(
					context.chatId,
					params.message,
					params.message_id
				);
				this.kuukiyomiHandler.increaseResponseRate(0.1);
				return { status: "success", action: "reply", message: params.message };

			case "chat_text":
				if (!params.message) {
					throw new Error("发送消息缺少内容参数");
				}
				if (this._checkMessageDuplicate(params.message, context)) {
					throw new Error("检测到重复消息");
				}
				params.message = this.processSendMessage(params.message);
				await this.botActionHelper.sendText(context.chatId, params.message);
				return { status: "success", action: "text", message: params.message };

			case "chat_note":
				if (!params.note) {
					throw new Error("记录笔记缺少必要参数");
				}
				await this.botActionHelper.saveAction(context.chatId, params.note, "note");
				return { status: "success", action: "note", note: params.note };

			case "chat_search":
				if (!params.keyword) {
					throw new Error("搜索缺少关键词参数");
				}
				let result = await this.botActionHelper.search(context.chatId, params.keyword);
				context.messageContext.push({
					content_type: "chat_search_called",
					text: `<keyword>${params.keyword}</keyword>`,
				});
				return {
					status: "success",
					action: "search",
					keyword: params.keyword,
					results: this.llmHelper.processMessageHistory(result, true),
				};

			case "web_search":
				if (!params.keyword) {
					throw new Error("搜索缺少关键词参数");
				}
				let webResult = await this.botActionHelper.googleSearch(params.keyword);
				context.messageContext.push({
					content_type: "web_search_called",
					text: `<keyword>${params.keyword}</keyword>`,
				});
				return {
					status: "success",
					action: "web_search",
					keyword: params.keyword,
					results: webResult,
				};

			case "web_getcontent":
				if (!params.url) {
					throw new Error("访问网页缺少URL参数");
				}
				let webContent = await this.botActionHelper.openURL(params.url);
				context.messageContext.push({
					content_type: "web_getcontent_called",
					text: `<url>${params.url}</url>`,
				});
				return {
					status: "success",
					action: "web_getcontent",
					url: params.url,
					content: webContent,
				};

			case "user_memories":
				if (!params.userid || !params.memories) {
					throw new Error("更新用户记忆缺少必要参数");
				}
				let memoryResult = await this.botActionHelper.updateMemory(
					params.userid,
					params.memories
				);
				return {
					status: "success",
					action: "update_memories",
					userid: params.userid,
					memories: params.memories,
				};

			default:
				throw new Error(`未知的工具调用: ${name}`);
		}
	}

	/**
	 * 检查消息是否重复
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

	/**
	 * 获取工具定义
	 */
	getTools() {
		return [
			{
				type: "function",
				function: {
					name: "chat_skip",
					description: "跳过当前消息，不进行回复",
					parameters: {
						type: "object",
						properties: {},
						required: [],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "chat_text",
					description: "直接向群内发送消息",
					parameters: {
						type: "object",
						properties: {
							message: {
								type: "string",
								description: "要发送的内容",
							},
						},
						required: ["message"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "chat_reply",
					description: "回复某一条消息",
					parameters: {
						type: "object",
						properties: {
							message_id: {
								type: "string",
								description: "要回复的消息ID",
							},
							message: {
								type: "string",
								description: "要发送的内容",
							},
						},
						required: ["message_id", "message"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "chat_note",
					description: "记录群聊笔记，用符合心情的语气记录",
					parameters: {
						type: "object",
						properties: {
							note: {
								type: "string",
								description: "要记录的事件、参与者和想法",
							},
						},
						required: ["note"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "chat_search",
					description: "检索聊天记录",
					parameters: {
						type: "object",
						properties: {
							keyword: {
								type: "string",
								description: "一个陈述句来描述你要搜索的内容",
							},
						},
						required: ["keyword"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "user_memories",
					description: "更新用户记忆",
					parameters: {
						type: "object",
						properties: {
							userid: {
								type: "string",
								description: "该用户的UID",
							},
							memories: {
								type: "string",
								description: "要更新或者添加的长期记忆内容",
							},
						},
						required: ["userid", "memories"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "web_search",
					description: "使用谷歌搜索互联网",
					parameters: {
						type: "object",
						properties: {
							keyword: {
								type: "string",
								description: "搜索关键词",
							},
						},
						required: ["keyword"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "web_getcontent",
					description: "根据URL获取内容",
					parameters: {
						type: "object",
						properties: {
							url: {
								type: "string",
								description: "要访问的url",
							},
						},
						required: ["url"],
					},
				},
			},
		];
	}

	/*
	 * 发送消息前处理
	 * 把句子中的英文逗号替换为中文逗号，vertical quote换成curved quote
	 */
	processSendMessage(message) {
		if (!message) return message;

		// 替换英文逗号为中文逗号
		let processed = message.replace(/,/g, "，");

		// 把所有vertical quotes替换成curved quotes
		processed = processed
			// 处理双引号
			.replace(/"([^"]*?)"/g, "“$1”")
			// 处理单引号
			.replace(/'([^']*?)'/g, "‘$1’");

		return processed;
	}
}

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
				this.chatConfig.actionGenerator.maxRetries
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

		// 从消息历史中收集所有唯一用户ID
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

		// 添加可用函数
		userRoleMessages.push(
			`<function>
你可以使用以下函数和参数，一次可以调用多个函数，列表如下：`
		);
		if (context.responseDecision.decisionType == "random") {
			userRoleMessages.push(`# 跳过（不回复，无参数）
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
<note>要记录的事件、参与者和你的想法</note>
</chat_note> 

# 检索聊天记录
<chat_search>
<keyword>一个陈述句来描述你要搜索的内容</keyword>
</chat_search>

# 更新用户记忆
<user_memories>
<userid>该用户的UID</userid>
<memories>要更新或者添加的长期记忆内容</memories>
</user_memories>

# 使用谷歌搜索互联网
<web_search>
<keyword>搜索关键词</keyword>
</web_search>

# 根据URL获取内容
<web_getcontent>
<url>要访问的url</url>
</web_getcontent>
</function>
`);
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
			let extractResult = this.llmHelper.extractFunctionCalls(
				response,
				[
					"chat_search",
					"chat_text",
					"chat_reply",
					"chat_note",
					"chat_skip",
					"web_search",
					"web_getcontent",
					"user_memories",
				],
				["chat_search", "web_search", "web_getcontent"]
			);
			let functionCalls = extractResult.functionCalls;
			response = extractResult.response;

			for (let call of functionCalls) {
				let { function: funcName, params } = call;

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
						// 检查重复
						if (this._checkMessageDuplicate(params.message, context)) {
							if (this.chatConfig.debug) console.log("跳过相似回复:", params.message);
							continue;
						}
						params.message = this.processSendMessage(params.message);
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
						// 检查重复
						if (this._checkMessageDuplicate(params.message, context)) {
							if (this.chatConfig.debug) console.log("跳过相似消息:", params.message);
							continue;
						}
						params.message = this.processSendMessage(params.message);
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
						await this.handleRAGSearchResults(result, context);
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
						await this.handleGoogleSearchResults(webResult, context);
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
						await this.handleWebContent(webContent, context);
						break;

					case "user_memories":
						if (!params.userid || !params.memories) {
							console.warn("更新用户记忆缺少必要参数");
							continue;
						}
						let memoryResult = await this.botActionHelper.updateMemory(
							params.userid,
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
	 * 处理历史搜索结果
	 */
	async handleRAGSearchResults(searchResults, context) {
		context.similarMessage = "";
		let botActionResult = this.llmHelper.processMessageHistory(searchResults, true);
		context.messageContext.push({
			content_type: "chat_search_result",
			text: botActionResult,
		});
		let messages = await this.prepareMessages(context);
		let newResponse = await this.llmHelper.callLLM(
			messages,
			null,
			this.chatConfig.actionGenerator.backend,
			this.chatConfig.actionGenerator.maxRetries
		);
		return this.processResponse(newResponse, context);
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

	/**
	 * 处理谷歌搜索结果
	 */
	async handleGoogleSearchResults(searchResults, context) {
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
		let newResponse = await this.llmHelper.callLLM(
			messages,
			null,
			this.chatConfig.actionGenerator.backend,
			this.chatConfig.actionGenerator.maxRetries
		);
		return this.processResponse(newResponse, context);
	}

	/**
	 * 处理网页打开结果
	 */
	async handleWebContent(webContent, context) {
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
		let newResponse = await this.llmHelper.callLLM(
			messages,
			null,
			this.chatConfig.actionGenerator.backend,
			this.chatConfig.actionGenerator.maxRetries
		);
		return this.processResponse(newResponse, context);
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
}

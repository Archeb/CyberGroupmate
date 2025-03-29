import { LLMHelper } from "../helpers/llmHelper.js";

export class KuukiyomiHandler {
	constructor(chatConfig, ragHelper, botActionHelper) {
		// 初始化基础配置
		this.chatConfig = chatConfig;
		this.config = chatConfig.kuukiyomi;

		this.llmHelper = new LLMHelper(chatConfig, botActionHelper);
		this.botActionHelper = botActionHelper;
		this.ragHelper = ragHelper;

		// 初始化状态追踪
		this.initializeStateTracking();

		// 初始化响应率调整参数
		this.initializeRateAdjustment();

		// 启动衰减计时器
		this.startDecayTimer();
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
					name: "chat_recall",
					description: "检索聊天回忆",
					parameters: {
						type: "object",
						properties: {
							keyword: {
								type: "string",
								description: "回忆关键词",
							},
						},
						required: ["keyword"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "web_getanswer",
					description: "联网获取答案",
					parameters: {
						type: "object",
						properties: {
							keyword: {
								type: "string",
								description: "陈述句描述你要提问的内容",
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
			{
				type: "function",
				function: {
					name: "chat_join",
					description: "参与话题",
					parameters: {
						type: "object",
						properties: {},
						required: [],
					},
				},
			},
		];
	}

	initializeStateTracking() {
		// 初始化响应概率
		this.currentResponseRate = this.config.initialResponseRate;

		// 初始化响应时间和消息频率追踪
		this.lastResponseTime = new Map();

		// 初始化统计数据
		this.stats = {
			mentionCount: 0, // 被提及次数
			triggerWordCount: 0, // 触发词出现次数
			lastInteractionTime: Date.now(), // 上次交互时间
		};
	}

	initializeRateAdjustment() {
		this.rateAdjustment = {
			mentionMultiplier: 0.2, // 每次被提及增加的基础值
			triggerWordMultiplier: 0.2, // 每次触发词出现增加的基础值
			decayRate: 0.1, // 每分钟衰减率
			decayInterval: 20000, // 衰减检查间隔（毫秒）
		};
	}

	/**
	 * 读空气思考
	 */
	async consider(decision, processedMsg) {
		if (!decision.shouldAct) return decision;

		try {
			// 提取上下文
			let msgHistory = await this.ragHelper.getMessageContext(
				processedMsg.metadata.chat.id,
				processedMsg.message_id,
				25
			);

			// 准备prompt
			let messages = await this.prepareMessages(msgHistory, decision);

			// 调用API（传递signal）
			let response = await this.llmHelper.callLLM(
				messages,
				null,
				this.chatConfig.kuukiyomi.backend,
				1,
				this.getTools()
			);

			// 处理响应
			return await this.processResponse(processedMsg, response, decision);
		} catch (error) {
			console.error("读空气思考失败:", error);
			// 读空气失败就让主模型读
			return decision;
		}
	}

	/**
	 * 准备发送给LLM的消息
	 */
	async prepareMessages(msgHistory, decision) {
		// 添加系统提示词，这里用system role
		let messages = [
			{
				role: "system",
				content:
					this.chatConfig.kuukiyomi.analyzeSystemPrompt +
					`<facts>
现在的时间是${new Date().toLocaleString("zh-CN", { timeZone: this.chatConfig.actionGenerator.timeZone })}
当前唤起场景为${decision.scene}。
</facts>`,
			},
		];

		//从这里开始用 user role，所有消息先用回车分隔，最后再合并到 user role message 里
		let userRoleMessages = [];

		// 添加历史消息
		userRoleMessages.push(
			"<chat_recall>\n" +
				this.llmHelper.processMessageHistory(msgHistory, true, true) +
				"\n</chat_recall>"
		);

		// 添加任务
		userRoleMessages.push(this.chatConfig.kuukiyomi.analyzeTaskPrompt);

		// 将所有用户消息合并
		messages.push({ role: "user", content: userRoleMessages.join("\n") });

		return messages;
	}

	/**
	 * 处理LLM的响应
	 */
	async processResponse(processedMsg, response, decision) {
		if (!response) return;

		try {
			// 处理工具调用
			if (response.message?.tool_calls) {
				let messages = [];
				let needsFollowUp = false;

				// 添加原始对话历史
				messages = [
					...(await this.prepareMessages(
						await this.ragHelper.getMessageContext(
							processedMsg.metadata.chat.id,
							processedMsg.message_id,
							25
						),
						decision
					)),
				];

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
						toolResult = await this.executeToolCall(
							processedMsg,
							params,
							decision,
							name
						);

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

				// 只有在需要后续对话时才继续对话
				if (needsFollowUp) {
					// 调用 LLM 继续对话
					let newResponse = await this.llmHelper.callLLM(
						messages,
						null,
						this.chatConfig.kuukiyomi.backend,
						1,
						this.getTools()
					);

					return this.processResponse(processedMsg, newResponse, decision);
				}
			}

			return decision;
		} catch (error) {
			console.error("处理读空气思考响应出错:", error);
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
		const followUpTools = new Set([]); // 读空气不需要后续对话
		return followUpTools.has(toolName);
	}

	/**
	 * 执行单个工具调用
	 */
	async executeToolCall(processedMsg, params, decision, name) {
		decision.relatedContext = [];
		switch (name) {
			case "chat_skip":
				decision.shouldAct = false;
				decision.decisionType = "skip";
				return { status: "success", action: "skip" };

			case "chat_recall":
				if (!params.keyword) {
					throw new Error("回忆缺少关键词参数");
				}
				let result = await this.ragHelper.searchSimilarContent(
					processedMsg.metadata.chat.id,
					params.keyword,
					{
						limit: 10,
						contentTypes: ["note"],
						timeWindow: "99 years",
					}
				);
				decision.relatedContext.push({
					content_type: "chat_recall_called",
					text: `<keyword>${params.keyword}</keyword>`,
				});
				return {
					status: "success",
					action: "recall",
					keyword: params.keyword,
					results: this.llmHelper.processMessageHistory(result, true),
				};

			case "web_getanswer":
				if (!params.keyword) {
					throw new Error("搜索缺少关键词参数");
				}
				let answerResult = await this.botActionHelper.quickAnswer(params.keyword);
				if (answerResult.success) {
					decision.relatedContext.push({
						content_type: "web_getanswer_result",
						text: answerResult.answer,
					});
				}
				return {
					status: "success",
					action: "web_answer",
					keyword: params.keyword,
					answer: answerResult.success ? answerResult.answer : "获取答案失败",
				};

			case "web_getcontent":
				if (!params.url) {
					throw new Error("访问网页缺少URL参数");
				}
				let webContent = await this.botActionHelper.openURL(params.url);
				let webContentText = webContent.success
					? `<title>${webContent.title}</title>\n<content>\n${webContent.content}\n${webContent.truncated ? "网页内容超长被截断" : ""}\n</content>`
					: "URL打开失败";

				decision.relatedContext.push({
					content_type: "web_getcontent_result",
					text: webContentText,
				});
				return {
					status: "success",
					action: "web_content",
					url: params.url,
					content: webContentText,
				};

			case "chat_join":
				return { status: "success", action: "join" };

			default:
				throw new Error(`未知的工具调用: ${name}`);
		}
	}

	/**
	 * 判断是否应该响应（机械响应条件）
	 */
	async shouldAct(processedMsg) {
		const result = {
			shouldAct: false,
			reason: "",
			decisionType: "normal",
		};

		try {
			if (this.chatConfig.debug) console.log("当前响应概率为：" + this.currentResponseRate);

			if (processedMsg.metadata.chat.type == "private") {
				this.stats.mentionCount++;
				this.stats.lastInteractionTime = Date.now(); // 更新主动交互时间
				result.shouldAct = true;
				result.decisionType = "private";
				result.scene = "当前唤起场景为私聊";
				this.adjustResponseRate(); // 调整响应率
				this.lastResponseTime.set(processedMsg.chat_id, Date.now());
				return result;
			}

			// 优先 检查是否被提及或回复
			if (
				processedMsg.metadata.reply_to_message?.from?.id ==
					this.chatConfig.telegram.botToken.split(":")[0] ||
				processedMsg.text?.includes(`@${this.chatConfig.telegram.botUsername}`)
			) {
				this.stats.mentionCount++;
				this.stats.lastInteractionTime = Date.now(); // 更新主动交互时间
				result.shouldAct = true;
				result.decisionType = "mention";
				result.scene = "当前唤起场景为被提及或回复";
				this.adjustResponseRate(); // 调整响应率
				this.lastResponseTime.set(processedMsg.chat_id, Date.now());
				return result;
			}

			// 检查是否是上一条bot回复对象的发言
			try {
				const msgHistory = await this.ragHelper.getMessageContext(
					processedMsg.metadata.chat.id,
					processedMsg.message_id,
					25
				);

				// 从历史消息中找到所有bot的回复
				const botMessages = msgHistory.filter((msg) => msg.content_type === "reply");

				if (botMessages.length > 0) {
					// 提取所有被回复的用户ID列表
					const repliedUserIds = new Set();

					// 遍历所有bot回复，收集被回复的用户
					for (const botMessage of botMessages) {
						// 检查直接回复
						if (botMessage.metadata.reply_to_message_id) {
							const repliedUser = msgHistory.find(
								(msg) => msg.message_id === botMessage.metadata.reply_to_message_id
							);
							if (repliedUser) {
								repliedUserIds.add(repliedUser.metadata.from.id);
							}
						}
					}

					// 如果当前消息发送者在被回复用户列表中
					if (repliedUserIds.has(processedMsg.metadata.from?.id)) {
						this.stats.mentionCount++;
						this.stats.lastInteractionTime = Date.now();
						result.shouldAct = true;
						result.decisionType = "follow-up";
						result.scene = "当前唤起场景为回复对象的后续发言";
						this.adjustResponseRate();
						this.lastResponseTime.set(processedMsg.chat_id, Date.now());
						return result;
					}
				}
			} catch (error) {
				console.error("检查follow-up时出错:", error);
			}

			// 优先 触发词
			const matchedTriggerWord = this.checkTriggerWords(processedMsg.text);
			if (matchedTriggerWord) {
				this.stats.triggerWordCount++;
				this.stats.lastInteractionTime = Date.now(); // 更新主动交互时间
				result.shouldAct = true;
				result.decisionType = "trigger";
				result.scene = `当前唤起场景为触发词匹配："${matchedTriggerWord}"`;
				this.adjustResponseRate(); // 调整响应率
				this.lastResponseTime.set(processedMsg.chat_id, Date.now());
				return result;
			}

			// 检查冷却时间
			if (!this.checkCooldown(processedMsg.chat_id)) {
				result.scene = "冷却时间内";
				return result;
			}

			// 检查忽略词
			if (this.checkIgnoreWords(processedMsg.text)) {
				result.scene = "忽略词匹配";
				return result;
			}

			// 随机响应判断
			if (Math.random() < this.currentResponseRate) {
				result.shouldAct = true;
				result.decisionType = "random";
				result.scene =
					"随机触发，请谨慎发言。对于已经有人在讨论的话题，不要乱接话，避免反感。";

				this.lastResponseTime.set(processedMsg.chat_id, Date.now());
				return result;
			}

			result.scene = "未满足任何触发条件";
			return result;
		} catch (error) {
			console.error("判断响应时出错:", error);
			result.scene = "处理错误";
			return result;
		}
	}

	/**
	 * 检查冷却时间
	 */
	checkCooldown(chatId) {
		const now = Date.now();
		const lastResponse = this.lastResponseTime.get(chatId) || 0;

		if (now - lastResponse < this.config.cooldown) {
			return false;
		}

		return true;
	}

	/**
	 * 检查触发词
	 */
	checkTriggerWords(text) {
		if (!text || !this.config.triggerWords.length) return false;
		const matchedWord = this.config.triggerWords.find((word) => text.includes(word));
		return matchedWord || false;
	}

	/**
	 * 检查忽略词
	 */
	checkIgnoreWords(text) {
		if (!text || !this.config.ignoreWords.length) return false;
		return this.config.ignoreWords.some((word) => text.includes(word));
	}

	// 衰减计时器
	startDecayTimer() {
		setInterval(() => {
			this.adjustResponseRate();
		}, this.rateAdjustment.decayInterval);
	}

	// 计算响应率
	calculateNewResponseRate() {
		const timeSinceLastInteraction = (Date.now() - this.stats.lastInteractionTime) / 60000; // 转换为分钟
		const decayFactor = Math.max(
			0,
			1 - timeSinceLastInteraction * this.rateAdjustment.decayRate
		);

		// 如果当前响应率已经降到最低，并且有新的主动交互，直接提升到最高响应率
		if (
			this.currentResponseRate <= this.config.responseRateMin &&
			(this.stats.mentionCount > 0 || this.stats.triggerWordCount > 0)
		) {
			return this.config.responseRateMax;
		}

		let newRate = this.currentResponseRate;

		// 根据统计数据调整响应率
		newRate += this.stats.mentionCount * this.rateAdjustment.mentionMultiplier;
		newRate += this.stats.triggerWordCount * this.rateAdjustment.triggerWordMultiplier;

		// 应用衰减
		newRate *= decayFactor;

		// 确保在允许范围内
		return Math.min(
			Math.max(newRate, this.config.responseRateMin),
			this.config.responseRateMax
		);
	}

	// 调整响应率
	adjustResponseRate() {
		this.currentResponseRate = this.calculateNewResponseRate();

		// 重置计数器
		this.stats.mentionCount = 0;
		this.stats.triggerWordCount = 0;
	}

	// 直接增加响应率
	increaseResponseRate(amount) {
		this.currentResponseRate = Math.min(
			this.currentResponseRate + amount,
			this.config.responseRateMax
		);
	}

	// 直接减少响应率
	decreaseResponseRate(amount) {
		this.currentResponseRate = Math.max(
			this.currentResponseRate - amount,
			this.config.responseRateMin
		);
	}
}

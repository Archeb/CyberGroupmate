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
	 * 前置思考
	 */
	async consider(processedMsg) {
		const decision = this.shouldAct(processedMsg);
		if (this.chatConfig.debug) console.log("响应决策：", decision);
		if (!decision.shouldAct) return decision;

		try {
			// 如果满足机械响应条件，进一步思考

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
				3
			);

			// 处理响应
			return await this.processResponse(processedMsg, response, decision);
		} catch (error) {
			console.error("读空气思考失败:", error);
			throw error;
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
			"<chat_history>\n" +
				this.llmHelper.processMessageHistory(msgHistory, true, true) +
				"\n</chat_history>"
		);

		// 添加可用函数
		userRoleMessages.push(
			`<function>
你可以使用以下函数和参数，一次可以调用多个函数，列表如下：`
		);
		if (decision.decisionType == "trigger") {
			userRoleMessages.push(`# 跳过（与用户无关，不回复）
<chat_skip>
</chat_skip>`);
		}
		userRoleMessages.push(`
# 检索聊天记录
<chat_search>
<keyword>一个陈述句来描述你要搜索的内容</keyword>
</chat_search>

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
			let extractResult = this.llmHelper.extractFunctionCalls(
				response,
				["chat_skip", "chat_search", "web_search", "web_getcontent"],
				[]
			);
			let functionCalls = extractResult.functionCalls;
			response = extractResult.response;

			decision.relatedContext = []; // 相关信息

			for (let call of functionCalls) {
				let { function: funcName, params } = call;

				switch (funcName) {
					case "chat_skip":
						decision.shouldAct = false;
						decision.decisionType = "skip";
						break;
					case "chat_search":
						if (!params.keyword) {
							console.warn("搜索缺少关键词参数");
							continue;
						}
						let result = await this.botActionHelper.search(
							processedMsg.metadata.chat.id,
							params.keyword
						);
						if (this.chatConfig.debug) console.log("history搜索结果：", result);
						decision.relatedContext.push({
							content_type: "chat_search_result",
							text: this.llmHelper.processMessageHistory(result, true),
						});
						break;

					case "web_search":
						if (!params.keyword) {
							console.warn("搜索缺少关键词参数");
							continue;
						}
						let webResult = await this.botActionHelper.googleSearch(params.keyword);
						if (this.chatConfig.debug) console.log("web搜索结果：", webResult);
						let searchResultText = `Web搜索关键词：${params.keyword}。搜索结果：`;
						for (let item of webResult) {
							searchResultText += `<title>${item.title}</title>
<url>${item.link}</url>
<snippet>${item.snippet}</snippet>
`;
						}

						decision.relatedContext.push({
							content_type: "web_search_result",
							text: searchResultText,
						});

						break;

					case "web_getcontent":
						if (!params.url) {
							console.warn("访问网页缺少URL参数");
							continue;
						}
						let webContent = await this.botActionHelper.openURL(params.url);
						if (this.chatConfig.debug) console.log("打开网页结果", webContent);
						let webContentText = "打开了URL " + params.url + " 结果：";
						if (webContent.success) {
							webContentText = `
<title>${webContent.title}</title>
<content>
${webContent.content}
${webContent.truncated ? "网页内容超长被截断" : ""}
</content>
`;
						} else {
							webContentText = `URL打开失败`;
						}
						decision.relatedContext.push({
							content_type: "web_getcontent_result",
							text: webContentText,
						});

						break;
				}
			}

			return decision;
		} catch (error) {
			console.error("处理读空气思考响应出错:", error);
			throw error;
		}
	}

	/**
	 * 判断是否应该响应（机械响应条件）
	 */
	shouldAct(processedMsg) {
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
				return result;
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

		this.lastResponseTime.set(chatId, now);
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

export class KuukiyomiHandler {
	constructor(chatConfig = {}) {
		// 初始化基础配置
		this.chatConfig = chatConfig;
		this.config = chatConfig.kuukiyomi;

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
	 * 判断是否应该响应消息
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

	/**
	 * 重置特定聊天的冷却时间
	 */
	resetCooldown(chatId) {
		this.lastResponseTime.delete(chatId);
	}

	// 添加新方法：启动衰减计时器
	startDecayTimer() {
		setInterval(() => {
			this.adjustResponseRate();
		}, this.rateAdjustment.decayInterval);
	}

	// 添加新方法：计算响应率
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

	// 添加新方法：调整响应率
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

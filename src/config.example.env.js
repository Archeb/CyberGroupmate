const env = process.env;

const config = {
	base: {
		telegram: {
			botToken: env.BOT_TOKEN,
			botUsername: env.BOT_USERNAME,
		},
		debug: false,
		actionGenerator: {
			// 主LLM，主要负责群聊行动
			backend: [
				// 这里是数组，可以配置多个LLM，随机抽选一个后端
				{
					apiKey: env.OPEN_AI_API_KEY,
					baseURL: env.OPEN_AI_API_BASE_URL,
					model: env.MAIN_MODEL,
					maxTokens: 2000,
					temperature: JSON.parse(env.TEMPERATURE),
				},
			],
			systemPrompt: "你是一个群友",
			jailbreakPrompt: "",
			interruptTimeout: 5000, // 允许打断时间（在这段时间内收到新消息将会打断思考重新生成），单位ms，不可覆盖属性
			maxRetryCount: 2, // 最大允许打断次数，不可覆盖属性
			maxAllowedDiff: 2, // 防重复配置，有多少个字差异的两句话会被视为相同。
			maxStackDepth: 1, // 函数调用深度
		},
		vision: {
			// 视觉识别模型
			backend: {
				apiKey: env.VISION_AI_API_KEY,
				baseURL: env.VISION_AI_API_BASE_URL,
				model: env.VISION_MODEL, // 需要能识别图片的模型
			},
		},
		postgres: {
			host: "pgvector",
			port: 5432,
			database: "postgres",
			user: "postgres",
			password: "123456",
		},
		rag: {
			// 处理嵌入，需要用到text-embedding-3-small 和 large 两个模型
			backend: {
				apiKey: env.RAG_API_KEY,
				baseURL: env.RAG_API_BASE_URL,
			},
		},
		secondaryLLM: {
			// 辅助LLM，主要负责记忆
			backend: {
				apiKey: env.SECONDARY_API_KEY,
				baseURL: env.SECONDARY_API_BASE_URL,
				model: env.SECONDARY_MODEL,
			},
		},
		google: {
			// Google Custom Search JSON API
			apiKey: env.GOOGLE_API_KEY,
			cseId: env.GOOGLE_CSE_ID,
		},
		kuukiyomi: {
			initialResponseRate: 0.1,
			cooldown: 3000,
			groupRateLimit: 100,
			userRateLimit: 50,
			triggerWords: [],
			ignoreWords: [],
			responseRateMin: 0.05,
			responseRateMax: 1,
		},
		availableStickerSets: JSON.parse(env.AVAILABLE_STICKER_SETS),
		memoChannelId: JSON.parse(env.MEMO_CHANNEL_ID),
		enableMemo: true,
		blacklistUsers: [],
	},
	collections: [
		{
			id: "default",
			name: "默认配置",
			config: {
				backend: {
					maxTokens: 2000,
					temperature: JSON.parse(env.TEMPERATURE),
				},
			},
			chats: [
				{
					id: JSON.parse(env.CHAT_ID),
					name: env.CHAT_NAME,
					config: {
						kuukiyomi: {
							initialResponseRate: JSON.parse(env.INITIAL_RESPONSE_RATE),
							responseRateMin: JSON.parse(env.RESPONSE_RATE_MIN),
							responseRateMax: JSON.parse(env.RESPONSE_RATE_MAX),
						},
					},
				},
			],
		},
	],
};

export default config;

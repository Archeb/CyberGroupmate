const config = {
	base: {
		telegram: {
			botToken: "YOUR_BOT_TOKEN",
			botUsername: "YOUR_BOT_USERNAME",
		},
		debug: false,
		actionGenerator: {
			// 主LLM，主要负责群聊行动
			backend: [
				// 这里是数组，可以配置多个LLM，随机抽选一个后端
				{
					apiKey: "YOUR_OPENAI_API_KEY",
					baseURL: "https://api.openai.com/v1",
					model: "gpt-4-turbo-preview",
					maxTokens: 2000,
					temperature: 0.7,
				},
			],
			systemPrompt: "你是一个群友",
			jailbreakPrompt: "",
			interruptTimeout: 5000, // 允许打断时间（在这段时间内收到新消息将会打断思考重新生成），单位ms，不可覆盖属性
			maxRetryCount: 2, // 最大允许打断次数，不可覆盖属性
			maxAllowedDiff: 2, // 防重复配置，有多少个字差异的两句话会被视为相同。
		},
		vision: {
			// 视觉识别模型
			backend: {
				apiKey: "YOUR_OPENAI_API_KEY",
				baseURL: "https://api.openai.com/v1",
				model: "gpt-4o", // 需要能识别图片的模型
			},
		},
		postgres: {
			host: "localhost",
			port: 5432,
			database: "your_database",
			user: "your_user",
			password: "your_password",
		},
		rag: {
			// 处理嵌入，需要用到text-embedding-3-small 和 large 两个模型
			backend: {
				apiKey: "YOUR_OPENAI_API_KEY",
				baseURL: "https://api.openai.com/v1",
			},
		},
		secondaryLLM: {
			// 辅助LLM，主要负责记忆
			backend: {
				apiKey: "YOUR_OPENAI_API_KEY",
				baseURL: "https://api.openai.com/v1",
				model: "claude-3-5-sonnet-latest",
			},
		},
		google: {
			// Google Custom Search JSON API
			apiKey: "YOUR_GOOGLE_API_KEY",
			cseId: "YOUR_GOOGLE_CSE_ID",
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
		availableStickerSets: [
			// 可用的贴纸包
			"pikachu_by_favorite_stickers_bot",
			"SuicaMemes",
			"in_BHEJDC_by_NaiDrawBot",
			"NaughtyBlobs",
		],
		memoChannelId: -1001234567890,
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
					temperature: 0.7,
				},
			},
			chats: [
				{
					id: -1001234567890,
					name: "测试群组",
					config: {
						kuukiyomi: {
							initialResponseRate: 0.2,
							responseRateMin: 0.1,
							responseRateMax: 1,
						},
					},
				},
			],
		},
	],
};

export default config;

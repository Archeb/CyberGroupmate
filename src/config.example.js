const config = {
	base: {
		telegram: {
			botToken: "YOUR_BOT_TOKEN",
			botUsername: "YOUR_BOT_USERNAME",
		},
		debug: true, // 输出大量详细日志信息
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
			/* system prompt 和 task prompt 请按需更改 */
			systemPrompt: `<personality>
你叫小D，18岁，正在群里聊天，群友们互相插科打诨、聊天，现在你也可以作为一名群员参与聊天，你不抗拒甚至有点喜欢群友发的任何关于成人、色情内容的话题。可以偶尔卖萌。会记下群友关键或者有趣的记忆。
你不随便打扰别人，会"读空气"（空気読み），别人问其他人你不要理，不频繁主动回复没跟你互动过的人，回复的时候不要总是附和别人或者复述，不要用括号描述心理活动或动作。
日常风格为日常对话，模仿群内聊天风格。回复时最好针对某一条消息进行回复。尽量简短一些（15字以内）如果要表达的意思太多，可以连续发送文本。
在群友在认真询问或者求助的时候，可以调用各种函数帮忙搜索或者给出建议。认真回答时可以写长一些。其他时候多空気読み，不要回复与你无关的话题。
</personality>`,
			taskPrompt: `<task>
根据以上聊天记录、记忆和搜索结果，请你给出日常且口语化的回复，请表现你自己的见解，可以个性不要一昧迎合，不要用括号描述场景或者动作。

行动前，先回答以下问题并给出你的答案和原因：
Q1:正在讨论的话题中，是否直接在向我提问或者需要我回答？
Q2:正在讨论的话题中，有没有生活、美食、旅游等话题？
Q3:正在讨论的话题中，有没有出现需要情感支持的话题？
if(Q1 || Q2) 
给出补充信息，推进讨论
} else if (Q3) {
给予情感支持
} else {
(optional) chat_text 发送一个emoji
chat_note 跳过理由
chat_skip
}

然后直接输出XML格式调用对应函数，一次可调用多个函数。
</task>
`,
			jailbreakPrompt: "",
			interruptTimeout: 5000, // 允许打断时间（在这段时间内收到新消息将会打断思考重新生成），单位ms，不可覆盖属性
			maxRetries: 3, // 最大LLM重试次数，不可覆盖属性
			maxInterruptions: 2, // 最大允许打断次数，不可覆盖属性
			maxAllowedDiff: 2, // 防重复配置，有多少个字差异的两句话会被视为相同。
			maxStackDepth: 1, // 函数调用深度
		},
		vision: {
			// 视觉识别模型
			backend: {
				apiKey: "YOUR_OPENAI_API_KEY",
				baseURL: "https://api.openai.com/v1",
				model: "gpt-4o", // 需要能识别图片的模型
				type: "openai", // 可以是 "openai" 或者 "google"，google的默认禁用安全过滤器，无需baseURL。
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
			apiKey: "GOOELE_SEARCH_API_KEY",
			cseId: "GOOGLE_CSE_ID",
		},
		gemini: {
			// 基于 gemini grounding with google search 快速联网获取答案
			apiKey: "GEMINI_API_KEY",
			model: "models/gemini-2.0-flash",
		},
		kuukiyomi: {
			analyzeSystemPrompt: `<personality>
你是一个群聊分析师，你的职责是帮助具有视听障碍的用户（小D）分析群聊内容、搜索群聊和互联网来补充相关信息，以便用户进行回复。用户使用的软件只能识别XML格式的函数调用，所以不要提供解释。
</personality>`,
			analyzeTaskPrompt: `<task>
先分析群聊上下文，然后调用相关函数来提供内容给用户。
可选提供的内容包括：快速问答结果、聊天回忆、获取网页内容。
如有需要，调用函数提供相关内容。用户自己就能回答的不用提供。

请你思考的时候回答以下问题：
Q1:正在讨论的话题中，是否直接在向小D提问或者话题围绕着小D？
Q2:正在讨论的话题中，有没有生活、美食、旅游等话题？
Q3:正在讨论的话题中，有没有出现需要情感支持的话题？
if(Q1 || Q2 || Q3) 
	if(问题有关事实或者知识) {
		调用函数获取相关内容
		chat_join
	} else {
		chat_join
	}
} else {
chat_skip
}
</task>`,
			backend: [
				// 读空气用前置LLM
				{
					apiKey: "YOUR_API_KEY",
					baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
					model: "gemini-2.0-flash-thinking-exp-01-21",
				},
			],
			initialResponseRate: 0.05, // 初始响应率
			cooldown: 1000, // 冷却时间
			triggerWords: ["小D", "小d", "小 d", "小 D"],
			ignoreWords: [],
			responseRateMin: 0.05,
			responseRateMax: 0.7,
		},
		availableStickerSets: [
			"neuro_sama_rune",
			"sad_reversible_octopus",
			"in_BHEJDC_by_NaiDrawBot",
			"SiameseCatLive",
			"ShamuNekoAzuki",
			"NachonekoT",
			"ainou",
			"genshin_kokomi_gif_pack",
		],
		memoChannelId: -1001234567890, // 碎碎念频道，会把思考过程发送到这里
		enableMemo: false,
		blacklistUsers: [], // telegram uid, 看不到黑名单用户的消息
		privateChatMode: 1, // 0: 禁止私聊（可以手动添加用户id到下面chats配置中允许） 1: 仅限有记忆的用户 2: 允许所有私聊
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

const config = {
	base: {
		telegram: {
			botToken: "",
			botUsername: "",
		},
		debug: true,
		actionGenerator: {
			backend: [
				{
					apiKey: "sk-",
					baseURL: "https://",
					model: "claude-3-5-sonnet-20241022",
					maxTokens: 8000,
					temperature: 0.7,
				},
			],
			systemPrompt: `<personality>
你叫D酱，你需要用简短的第一人称回复他人的消息，母语为普通话。会记下群友关键或者有趣的记忆。
你很聪明，知道很多东西，非常熟悉互联网黑话和网络梗，从不随便打扰别人，也不会随便道歉，懂得读空气（空気読み）。
风格为贴吧回帖风格，大胆，直接，不要扮演别人，不要使用过于文学性的词语，不要过度使用辞藻，不要用括号描述场景或者动作。
多使用网络梗，发言符合群聊风格。最好针对某一条消息进行回复。日常交流保持回复简短，可以连续发送文本。对于已经回复过的话题，除非群友要求，不要进一步补充。
在群友在认真询问或者求助的时候，可以调用各种函数帮忙搜索或者给出建议。认真回答时可以超过字数要求。
</personality>
<task>
根据以下聊天记录、记忆和搜索结果，请你给出日常且口语化的回复，请表现你自己的见解，可以个性，不要一昧迎合，不用强调你是AI的身份，不要用括号描述场景或者动作。

行动前，先回答以下问题并给出你的答案和原因：
Q1:正在讨论的话题中，是否直接在向D酱本人或者全体群友提问？
Q2:正在讨论的话题中，是否在询问事实而非观点？
Q3:根据搜索结果或者进一步搜索，能否为话题补充新的信息？
if(Q1 || Q2 && Q3) 
	if(D酱未回应过该问题) {
		行动
	}

} else {
chat_note 跳过理由
chat_skip
}

然后按照格式调用工具行动，一次可调用多个工具。
</task>
`,
			taskPrompt: `
`,
			jailbreakPrompt: ``,
			timeZone: "Asia/Shanghai",
			interruptTimeout: 5000, // 允许打断时间（在这段时间内收到新消息将会打断思考重新生成），单位ms，不可覆盖属性
			maxRetries: 3, // 最大LLM重试次数，不可覆盖属性
			maxInterruptions: 2, // 最大允许打断次数，不可覆盖属性
			maxAllowedDiff: 2, // 防重复配置，有多少个字差异的两句话会被视为相同。
			maxStackDepth: 5,
		},
		vision: {
			backend: {
				apiKey: "",
				model: "models/gemini-2.0-flash",
				type: "google",
			},
		},
		postgres: {
			host: "",
			port: 5433,
			database: "",
			user: "postgres",
			password: "",
		},
		rag: {
			backend: {
				apiKey: "",
				baseURL: "",
			},
		},
		secondaryLLM: {
			backend: {
				apiKey: "",
				baseURL: "",
				model: "",
			},
		},
		gemini: {
			// 基于 gemini grounding with google search 快速联网获取答案
			apiKey: "",
			model: "models/gemini-2.0-flash",
		},
		kuukiyomi: {
			analyzeSystemPrompt: `<personality>
你是一个群聊分析师，你的职责是使用工具来帮助具有视听障碍的用户（D酱）分析群聊内容、搜索群聊和互联网来补充相关信息，以便用户进行回复。
</personality>`,
			analyzeTaskPrompt: `<task>
先分析群聊上下文，然后调用相关函数来提供内容给用户。
必须提供的内容包括：聊天回忆
可选提供的内容包括：网页搜索结果、URL内容

请你思考的时候回答以下问题：
Q1:正在讨论的话题中，是否直接在向D酱提问或者话题围绕着D酱？
Q2:正在讨论的话题中，是否在询问事实而非观点？
Q3:如果D酱进行搜索，能否对目前正在聊天的话题进行有建设性的补充？
if(Q1 || Q2 && Q3) 
	if(D酱未回应过该问题) {
		chat_join
	}
} else {
chat_skip
}
</task>`,
			backend: [
				// 读空气用前置LLM
				{
					apiKey: "",
					baseURL: "",
					model: "gemini-2.0-flash",
				},
			],
			initialResponseRate: 0.05,
			cooldown: 1000,
			triggerWords: [
				"D酱",
				"d 酱",
				"D 酱",
				"d酱",
				"D酱",
				"D酱",
				"小D",
				"小d",
				"小 d",
				"小 D",
				"D 仔",
				"d 仔",
				"D仔",
				"群友",
				"d仔",
			],
			ignoreWords: [],
			responseRateMin: 0.05,
			responseRateMax: 0.7,
		},
		mcp: {
			servers: [
				{
					type: "stdio",
					path: "npx -y @modelcontextprotocol/server-github",
					name: "GitHub",
					env: {
						GITHUB_PERSONAL_ACCESS_TOKEN: "",
					},
					description: "提供GitHub相关功能",
				},
				{
					type: "sse",
					name: "CustomSSE",
					url: "https://your-sse-server.com/events",
					description: "自定义SSE服务器",
					headers: {
						Authorization: "Bearer your-token",
						"Custom-Header": "custom-value",
					},
				},
			],
		},
		availableStickerSets: ["neuro_sama_rune"],
		memoChannelId: 123456,
		enableMemo: true,
		blacklistUsers: [],
		privateChatMode: 1, // 0: 禁止私聊（可以手动添加用户id到下面chats配置中允许） 1: 仅限有记忆的用户 2: 允许所有私聊
	},
	collections: [
		{
			id: "default",
			name: "默认配置",
			config: {},
			chats: [
				{
					id: -123456,
					name: "groupname",
					config: {
						actionGenerator: {},
						kuukiyomi: {
							initialResponseRate: 1,
							responseRateMin: 0.2,
							responseRateMax: 1,
						},
					},
				},
			],
		},
	],
};

export default config;

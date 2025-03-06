export class ConfigManager {
	constructor(baseConfig) {
		this.baseConfig = baseConfig;
		this.chatConfigs = new Map();
		this.initializeChatConfigs();
	}

	initializeChatConfigs() {
		// 遍历所有集合和聊天，构建配置映射
		this.baseConfig.collections.forEach((collection) => {
			collection.chats.forEach((chat) => {
				// 三层配置合并：base <- collection <- chat
				const mergedConfig = this.deepAssign(
					{},
					this.baseConfig.base,
					collection.config,
					chat.config
				);
				this.chatConfigs.set(chat.id, mergedConfig);
			});
		});
	}

	getChatConfig(chatId) {
		// 直接返回找到的配置或 null，不再返回 base 配置
		return this.chatConfigs.get(chatId) || null;
	}

	getBaseConfig() {
		return this.baseConfig.base;
	}

	/**
	 *判断对象是否是一个纯粹的对象
	 */
	isPlainObject(obj) {
		return typeof obj === "object" && Object.prototype.toString.call(obj) === "[object Object]";
	}

	/**
	 *深度合并多个对象的方法
	 */
	deepAssign() {
		let len = arguments.length,
			target = arguments[0];
		if (!this.isPlainObject(target)) {
			target = {};
		}
		for (let i = 1; i < len; i++) {
			let source = arguments[i];
			if (this.isPlainObject(source)) {
				for (let s in source) {
					if (s === "__proto__" || target === source[s]) {
						continue;
					}
					if (this.isPlainObject(source[s])) {
						target[s] = this.deepAssign(target[s], source[s]);
					} else {
						target[s] = source[s];
					}
				}
			}
		}
		return target;
	}
}

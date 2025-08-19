class StickerHelper {
	constructor(config, bot) {
		this.config = config;
		this.bot = bot;
		this.stickerMap = new Map(); // emoji -> sticker
		this.initialize();
	}

	async initialize() {
		try {
			for (const setName of this.config.availableStickerSets) {
				const stickerSet = await this.bot.getStickerSet(setName);
				for (const sticker of stickerSet.stickers) {
					if (!sticker.emoji) continue;

					// 一个emoji可能对应多个sticker
					if (!this.stickerMap.has(sticker.emoji)) {
						this.stickerMap.set(sticker.emoji, []);
					}
					this.stickerMap.get(sticker.emoji).push(sticker);
				}
			}
			console.log(`已加载 ${this.stickerMap.size} 个不同emoji的贴纸`);
		} catch (error) {
			console.error("加载贴纸集时出错:", error);
		}
	}

	getAvailableEmojis() {
		return Array.from(this.stickerMap.keys());
	}

	getRandomSticker(emoji) {
		const stickers = this.stickerMap.get(emoji);
		if (!stickers || stickers.length === 0) return null;

		const randomIndex = Math.floor(Math.random() * stickers.length);
		return stickers[randomIndex];
	}

	async stealSticker(stickerData, generatedEmoji) {
		try {
			if (!generatedEmoji || typeof generatedEmoji !== 'string') {
				console.warn('偷表情失败，emoji无效');
				return false;
			}

			if (!this.stickerMap.has(generatedEmoji)) {
				this.stickerMap.set(generatedEmoji, []);
			}

			const existingStickers = this.stickerMap.get(generatedEmoji);
			const isDuplicate = existingStickers.some(sticker => 
				sticker.file_unique_id === stickerData.file_unique_id
			);

			if (!isDuplicate) {
				this.stickerMap.get(generatedEmoji).push(stickerData);
				console.log(`已把emoji ${generatedEmoji} 对应的贴纸偷到手`);
				return true;
			} else {
				return false;
			}
		} catch (error) {
			console.error('偷表情包失败：', error);
			return false;
		}
	}
}

export { StickerHelper };

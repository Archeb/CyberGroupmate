import ogs from "open-graph-scraper";

export class TelegramHandler {
	constructor(chatConfig = {}, ragHelper, visionHelper, stickerHelper) {
		this.chatConfig = chatConfig;
		this.ragHelper = ragHelper;
		this.visionHelper = visionHelper;
		this.stickerHelper = stickerHelper;
	}

	/**
	 * 解析文本中的 URL 并获取 Open Graph 数据
	 * @param {string} text - 包含 URL 的文本
	 * @returns {Promise<string>} 解析后的文本
	 */
	async parseUrls(text) {
		try {
			// 使用正则表达式匹配 URL
			const urlRegex = /(https?:\/\/[^\s]+)/g;
			const urls = text.match(urlRegex);

			if (!urls) return text;

			let resultText = text;

			// 只处理前3个URL
			const urlsToProcess = urls.slice(0, 3);

			// 处理每个 URL
			for (const url of urlsToProcess) {
				try {
					const options = {
						url,
						timeout: 2000, // 2秒超时
						fetchOptions: {
							headers: {
								"user-agent":
									"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
							},
						},
					};

					const { result } = await ogs(options);

					if (result.success) {
						let ogInfo = "\n[链接预览]\n";
						if (result.ogTitle) ogInfo += `标题: ${result.ogTitle}\n`;
						if (result.ogDescription) ogInfo += `描述: ${result.ogDescription}\n`;

						// 将 URL 替换为 URL + Open Graph 信息
						resultText = resultText.replace(url, `${url}${ogInfo}`);
					}
				} catch (urlError) {
					console.error(`解析 URL 失败: ${url}`, urlError);
				}
			}

			return resultText;
		} catch (error) {
			console.error("URL 解析过程出错:", error);
			return text;
		}
	}

	/**
	 * 处理Telegram消息
	 * @param {Object} telegramMsg - Telegram原始消息对象
	 * @returns {Object|null} 标准化的消息对象
	 */
	async handleMessage(telegramMsg) {
		try {
			// 基础消息检查
			if (!telegramMsg || (!telegramMsg.text && !telegramMsg.photo && !telegramMsg.sticker)) {
				return null;
			}

			// 标准化消息格式
			let standardizedMsg = {
				// 基础字段
				chat_id: telegramMsg.chat.id,
				message_id: telegramMsg.message_id,
				content_type: "message",
				text: telegramMsg.text,

				// 元数据
				metadata: {
					from: {
						id: telegramMsg.from.id,
						is_bot: telegramMsg.from.is_bot,
						first_name: telegramMsg.from.first_name,
						last_name: telegramMsg.from.last_name,
						username: telegramMsg.from.username,
						language_code: telegramMsg.from.language_code,
					},
					chat: {
						id: telegramMsg.chat.id,
						type: telegramMsg.chat.type,
						title: telegramMsg.chat.title,
					},
					date: new Date(telegramMsg.date * 1000).toISOString(),
					message_thread_id: telegramMsg.message_thread_id,
				},
			};

			// 处理回复消息
			if (telegramMsg.reply_to_message) {
				standardizedMsg.metadata.reply_to_message = {
					message_id: telegramMsg.reply_to_message.message_id,
					text: telegramMsg.reply_to_message.text,
					from: {
						id: telegramMsg.reply_to_message.from.id,
						is_bot: telegramMsg.reply_to_message.from.is_bot,
						username: telegramMsg.reply_to_message.from.username || "",
						first_name: telegramMsg.reply_to_message.from.first_name || "",
						last_name: telegramMsg.reply_to_message.from.last_name || "",
					},
				};
			}

			// 处理转发消息
			if (telegramMsg.forward_origin) {
				standardizedMsg.metadata.forward_origin = {
					type: telegramMsg.forward_origin.type,
				};

				// 添加显示名称
				let displayName = "";

				// 根据不同的转发来源类型处理
				switch (telegramMsg.forward_origin.type) {
					case "user":
						const user = telegramMsg.forward_origin.sender_user;
						standardizedMsg.metadata.forward_origin.sender_user = {
							id: user.id,
							is_bot: user.is_bot,
							username: user.username || "",
							first_name: user.first_name || "",
							last_name: user.last_name || "",
						};
						displayName =
							[user.first_name, user.last_name].filter(Boolean).join(" ") ||
							user.username ||
							"未知用户";
						break;
					case "channel":
						const chat = telegramMsg.forward_origin.chat;
						standardizedMsg.metadata.forward_origin.chat = {
							id: chat.id,
							title: chat.title,
							username: chat.username || "",
						};
						standardizedMsg.metadata.forward_origin.message_id =
							telegramMsg.forward_origin.message_id;
						displayName = chat.title || chat.username || "未知频道";
						break;
					case "hidden_user":
						displayName = telegramMsg.forward_origin.sender_user_name;
						standardizedMsg.metadata.forward_origin.sender_user = {
							username: telegramMsg.forward_origin.sender_user_name,
						};
						break;
					default:
						displayName = "未知来源";
				}

				standardizedMsg.metadata.forward_origin.display_name = displayName;

				if (telegramMsg.forward_date) {
					standardizedMsg.metadata.forward_date = new Date(
						telegramMsg.forward_date * 1000
					).toISOString();
				}

				// 在文本前添加转发来源信息
				if (standardizedMsg.text) {
					standardizedMsg.text = `[转发自: ${displayName}]\n${standardizedMsg.text}`;
				}
			}

			// 处理媒体消息（如果有）
			if (telegramMsg.photo || telegramMsg.video || telegramMsg.document) {
				standardizedMsg.metadata.has_media = true;
				standardizedMsg.metadata.media_type = telegramMsg.photo
					? "photo"
					: telegramMsg.video
					? "video"
					: "document";

				// 即时处理：优先使用 caption，如果没有则使用默认文本
				standardizedMsg.text = telegramMsg.caption || "[图片]";
				standardizedMsg.metadata.has_caption = !!telegramMsg.caption;

				// 同步处理图片
				if (telegramMsg.photo) {
					// 获取最高质量的图片
					const photo = telegramMsg.photo[telegramMsg.photo.length - 1];
					standardizedMsg.metadata.media = {
						file_id: photo.file_id,
						file_unique_id: photo.file_unique_id,
						width: photo.width,
						height: photo.height,
						file_size: photo.file_size,
					};

					// 同步处理图片
					standardizedMsg = await this.processImage(standardizedMsg);
				}
			}

			// 处理 sticker
			if (telegramMsg.sticker) {
				standardizedMsg.metadata.has_media = true;
				standardizedMsg.metadata.media_type = "sticker";
				standardizedMsg.metadata.media = {
					file_id: telegramMsg.sticker.file_id,
					file_unique_id: telegramMsg.sticker.file_unique_id,
					width: telegramMsg.sticker.width,
					height: telegramMsg.sticker.height,
					is_animated: telegramMsg.sticker.is_animated,
					is_video: telegramMsg.sticker.is_video,
					emoji: telegramMsg.sticker.emoji,
				};

				// 获取或生成 sticker 描述
				let stickerDescription = await this.ragHelper.getStickerDescription(
					telegramMsg.sticker.file_unique_id,
					telegramMsg.sticker.file_id
				);

				if (!stickerDescription) {
					// 如果没有现有描述，使用 visionHelper 分析
					stickerDescription = await this.visionHelper.analyzeSticker(
						telegramMsg.sticker
					);
					if (stickerDescription) {
						await this.ragHelper.saveStickerDescription(
							telegramMsg.sticker.file_unique_id,
							telegramMsg.sticker.file_id,
							stickerDescription,
							{
								emoji: telegramMsg.sticker.emoji,
							}
						);
					}
				}

				standardizedMsg.text = "[贴纸描述：" + stickerDescription + "]" || "[贴纸]";
				standardizedMsg.metadata.sticker_description = stickerDescription;

				if (this.stickerHelper && telegramMsg.sticker.emoji && this.chatConfig.stealStickers) {
					await this.stickerHelper.stealSticker(telegramMsg.sticker, telegramMsg.sticker.emoji);
				}
			}

			// 在返回之前解析消息中的 URL
			if (standardizedMsg.text) {
				standardizedMsg.text = await this.parseUrls(standardizedMsg.text);
			}

			return standardizedMsg;
		} catch (error) {
			console.error("处理消息时出错:", error);
			return null;
		}
	}

	/**
	 * 同步处理图片
	 * @param {Object} standardizedMsg - 标准化的消息对象
	 * @returns {Object} 处理后的消息对象
	 */
	async processImage(standardizedMsg) {
		try {
			// 获取图片描述
			const imageDescription = await this.visionHelper.analyzeImage(standardizedMsg);

			// 构建更新后的消息内容
			let updatedText;
			if (standardizedMsg.metadata.has_caption) {
				// 如果有 caption，保留原文并添加图片描述
				updatedText = `${standardizedMsg.text}\n[图片描述: ${imageDescription}]`;
			} else {
				// 如果没有 caption（即原文是[图片]），则只使用图片描述
				updatedText = `[图片描述: ${imageDescription}]`;
			}

			// 返回更新后的消息对象
			return {
				...standardizedMsg,
				text: updatedText,
				metadata: {
					...standardizedMsg.metadata,
					image_description: imageDescription,
					processed_at: new Date().toISOString(),
				},
			};
		} catch (error) {
			console.error("处理图片失败:", error);
			// 发生错误时返回带有错误信息的消息对象
			return {
				...standardizedMsg,
				metadata: {
					...standardizedMsg.metadata,
					image_analysis_error: error.message,
					processed_at: new Date().toISOString(),
				},
			};
		}
	}
}

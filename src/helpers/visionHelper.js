import { generateText } from "@xsai/generate-text";
import { createOpenAI } from '@xsai/providers'
import { message } from '@xsai/utils-chat'
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import fs from "fs";
import path from "path";

export class VisionHelper {
	constructor(chatConfig = {}, telegramBot, ragHelper) {
		this.chatConfig = chatConfig;
		this.telegramBot = telegramBot;
		this.ragHelper = ragHelper;

		// 初始化 OpenAI 客户端
		this.openai = createOpenAI({
			baseURL: this.chatConfig.vision.backend.baseURL,
			apiKey: this.chatConfig.vision.backend.apiKey,
		});

		this.model = this.chatConfig.vision.backend.model;
		ffmpeg.setFfmpegPath(ffmpegInstaller.path);
		ffmpeg.setFfprobePath(ffprobeInstaller.path);
		this.tmpDir = path.join(process.cwd(), "tmp");
		if (!fs.existsSync(this.tmpDir)) {
			fs.mkdirSync(this.tmpDir);
		}
	}

	/**
	 * 分析图片并返回描述
	 * @param {string} fileId - Telegram 文件 ID
	 * @returns {Promise<string>} 图片描述
	 */
	async analyzeImage(standardizedMsg) {
		try {
			// 1. 从 Telegram 获取文件链接
			const file = await this.telegramBot.getFile(standardizedMsg.metadata.media.file_id);
			const fileUrl = `https://api.telegram.org/file/bot${this.chatConfig.telegram.botToken}/${file.file_path}`;

			// 2. 获取消息上下文
			let contextMessages = "";
			if (standardizedMsg.message_id) {
				const context = await this.ragHelper.getMessageContext(
					standardizedMsg.chat_id,
					standardizedMsg.message_id,
					3 // 获取前后各3条消息
				);
				contextMessages = context.map((msg) => msg.text).join("\n");
			}

			// 3. 构建系统提示
			let systemPrompt =
				"你是一个图片描述助手。请用中文描述图片内容。描述要客观准确，不要加入主观评价。";

			// 如果有上下文，添加到系统提示中
			if (contextMessages) {
				systemPrompt +=
					"\n以下是图片发送前的聊天上下文，请参考它来理解图片的语境：\n" +
					contextMessages;
			}

			// 4. 构建用户提示
			let userPrompt = "请详细描述这张图片";
			// 如果有 caption，添加到提示中
			if (standardizedMsg.metadata.has_caption) {
				userPrompt += `\n图片发送者的说明文字是：${standardizedMsg.text}`;
			}

			// 5. 调用 OpenAI Vision API
			const response = await generateText({
				...this.openai.chat(this.model),
				messages: message.messages(
					message.system(systemPrompt),
					message.user([message.imagePart(userPrompt), message.imagePart(fileUrl)]),
				),
				max_tokens: 300,
			});

			if (this.chatConfig.debug) {
				console.log("Vision API 响应:", response);
			}

			// 6. 返回生成的描述
			return response.messages[response.messages.length-1]?.content || "无法生成图片描述";
		} catch (error) {
			console.error("图片分析失败:", error);
			throw new Error(`图片分析失败: ${error.message}`);
		}
	}

	/**
	 * 分析 Sticker 并返回描述
	 * @param {Object} sticker - Telegram sticker 对象
	 * @returns {Promise<string>} sticker 描述
	 */
	async analyzeSticker(sticker) {
		try {
			// 1. 获取 sticker 文件和贴纸包信息
			const file = await this.telegramBot.getFile(sticker.file_id);
			const fileUrl = `https://api.telegram.org/file/bot${this.chatConfig.telegram.botToken}/${file.file_path}`;

			// 获取贴纸包信息
			let stickerSetTitle = "";
			if (sticker.set_name) {
				try {
					const stickerSet = await this.telegramBot.getStickerSet(sticker.set_name);
					stickerSetTitle = stickerSet.title;
				} catch (error) {
					console.error("获取贴纸包信息失败:", error);
				}
			}

			// 2. 构建系统提示
			let systemPrompt =
				"你是一个表情贴纸描述助手。请用简短的中文描述这个表情贴纸传达的情感和画面内容（包括文字）。要考虑中国互联网流行文化和语境进行解释。";

			if (stickerSetTitle) {
				systemPrompt += `\n这个贴纸来自贴纸包"${stickerSetTitle}"`;
			}

			if (sticker.emoji) {
				systemPrompt += `\n这个贴纸对应的emoji是 ${sticker.emoji}，请将这个表情所表达的情感考虑进去。`;
			}

			// 3. 构建用户提示和图片内容
			let userPrompt = "请描述这个表情贴纸的画面内容和传达的情感";
			let imageContents = [];

			if (sticker.is_animated || sticker.is_video) {
				try {
					// 对于动画贴纸，我们需要抽取帧
					const frames = await this.extractStickerFrames(fileUrl);
					imageContents = frames.slice(0, 2).map((frameUrl) => (message.imagePart(frameUrl)));
					userPrompt += "\n这是一个动态贴纸的两个关键帧，请综合描述其动态效果。";
				} catch (error) {
					console.error("提取贴纸帧失败，将使用原始贴纸:", error);
					// 如果提取帧失败，回退到使用原始贴纸
					imageContents = [ message.imagePart(fileUrl) ];
					userPrompt += "\n这是一个动态贴纸，但无法提取帧画面。";
				}
			} else {
				// 静态贴纸直接使用原图
				imageContents = [ message.imagePart(fileUrl) ];
			}

			// 4. 调用 OpenAI Vision API
			const response = await generateText({
				...this.openai.chat(this.model),
				messages: message.messages(
					message.system(systemPrompt),
					message.user([message.textPart(userPrompt), ...imageContents])
				),
				max_tokens: 150,
			});

			if (this.chatConfig.debug) {
				console.log("Sticker Vision API 响应:", response);
			}

			// 5. 返回生成的描述
			const description = response.messages[response.messages.length-1]?.content || "无法生成贴纸描述";
			return stickerSetTitle ? `[${stickerSetTitle}]\n${description}` : description;
		} catch (error) {
			console.error("贴纸分析失败:", error);
			throw new Error(`贴纸分析失败: ${error.message}`);
		}
	}

	/**
	 * 从动态贴纸中提取关键帧
	 * @param {string} fileUrl - 贴纸文件URL
	 * @returns {Promise<string[]>} 帧图片URL数组
	 */
	async extractStickerFrames(fileUrl) {
		const response = await fetch(fileUrl);
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		const inputPath = path.join(this.tmpDir, `input_${Date.now()}.webm`);
		await fs.promises.writeFile(inputPath, buffer);

		try {
			// 首先获取视频信息
			const videoInfo = await new Promise((resolve, reject) => {
				ffmpeg.ffprobe(inputPath, (err, metadata) => {
					if (err) reject(err);
					else resolve(metadata);
				});
			});

			if (this.chatConfig.debug) {
				console.log("视频信息:", videoInfo);
			}

			// 检查 duration
			const duration = videoInfo.streams[0].duration;

			// 如果获取不到 duration 或者 duration 是 'N/A'，直接转成静态图片
			if (!duration || duration === "N/A") {
				const outputPath = path.join(this.tmpDir, `frame_1.jpg`);
				await new Promise((resolve, reject) => {
					ffmpeg(inputPath)
						.outputOptions("-frames:v", "1")
						.save(outputPath)
						.on("end", resolve)
						.on("error", reject);
				});

				const frameBuffer = await fs.promises.readFile(outputPath);
				const base64 = frameBuffer.toString("base64");
				await fs.promises.unlink(outputPath);
				await fs.promises.unlink(inputPath);
				return [`data:image/jpeg;base64,${base64}`];
			}

			// 对于有 duration 的视频，抽取两帧
			await new Promise((resolve, reject) => {
				const command = ffmpeg(inputPath).screenshots({
					count: 2,
					filename: "frame_%i.jpg",
					folder: this.tmpDir,
				});

				if (this.chatConfig.debug) {
					command.on("start", (commandLine) => {
						console.log("FFmpeg 命令:", commandLine);
					});
					command.on("progress", (progress) => {
						console.log("FFmpeg 进度:", progress);
					});
				}

				command.on("end", resolve).on("error", (err, stdout, stderr) => {
					reject({
						error: err,
						ffmpegOutput: stdout,
						ffmpegError: stderr,
					});
				});
			});

			// 读取生成的帧并转换为 base64
			const frameFiles = await Promise.all(
				Array.from({ length: 2 }, (_, i) => i + 1).map(async (i) => {
					const framePath = path.join(this.tmpDir, `frame_${i}.jpg`);
					const frameBuffer = await fs.promises.readFile(framePath);
					const base64 = frameBuffer.toString("base64");
					await fs.promises.unlink(framePath); // 清理临时文件
					return `data:image/jpeg;base64,${base64}`;
				})
			);

			await fs.promises.unlink(inputPath); // 清理输入文件
			return frameFiles;
		} catch (error) {
			console.error("提取帧失败:", {
				message: error.error?.message || error.message,
				ffmpegOutput: error.ffmpegOutput,
				ffmpegError: error.ffmpegError,
			});
			throw error;
		}
	}
}

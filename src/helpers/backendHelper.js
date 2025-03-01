import OpenAI from "openai";
import * as fs from "fs/promises";
import * as path from "path";

export class backendHelper {
	constructor(chatConfig, botActionHelper) {
		this.chatConfig = chatConfig;
		this.currentBackendIndex = 0; // 轮询索引
		this.botActionHelper = botActionHelper;
	}

	/**
	 * 调用LLM API
	 */
	async callLLM(messages, signal) {
		let lastError;

		for (let attempt = 0; attempt < this.chatConfig.actionGenerator.maxRetries; attempt++) {
			try {
				// 轮询选择backend配置
				const backends = this.chatConfig.actionGenerator.backend;
				const backendConfig = backends[this.currentBackendIndex % backends.length];

				// 使用选中的backend配置初始化OpenAI客户端
				let openai = new OpenAI({
					apiKey: backendConfig.apiKey,
					baseURL: backendConfig.baseURL,
				});

				// o3/o1 兼容
				const maxTokensParam =
					backendConfig.model.startsWith("o3") || backendConfig.model.startsWith("o1")
						? "max_completion_tokens"
						: "max_tokens";

				const completionParams = {
					model: backendConfig.model,
					messages: messages,
					[maxTokensParam]: backendConfig.maxTokens, // 使用动态参数名
				};

				if (
					!(backendConfig.model.startsWith("o3") || backendConfig.model.startsWith("o1"))
				) {
					completionParams.temperature = backendConfig.temperature;
				}

				let completion = await openai.chat.completions.create(completionParams, {
					signal: signal,
				});

				this.currentBackendIndex++; // 递增索引

				if (typeof completion === "string") completion = JSON.parse(completion);

				// 合并reasoning和content
				let response =
					(completion.choices[0].message?.reasoning ||
						completion.choices[0].message?.reasoning_content ||
						"") + completion.choices[0].message?.content || "";

				if (this.chatConfig.debug) {
					// 保存日志到文件
					let timestamp = new Date().toISOString().replace(/[:.]/g, "-");
					let logContent = [
						// 输入消息
						messages.map((msg) => `--- ${msg.role} ---\n${msg.content}\n`).join("\n"),
						// 分隔线
						"\n=== Response ===\n",
						// 响应内容
						response,
						// 模型
						`model: ${backendConfig.model}`,
					].join("\n");

					// 确保logs目录存在
					await fs.mkdir("logs", { recursive: true });

					// 写入日志文件
					await fs.writeFile(path.join("logs", `${timestamp}.txt`), logContent, "utf-8");
				}
				// 保存碎碎念
				if (this.chatConfig.memoChannelId && this.chatConfig.enableMemo) {
					this.botActionHelper.sendText(
						this.chatConfig.memoChannelId,
						["response:", response, "model:", backendConfig.model].join("\n"),
						false,
						false
					);
				}

				if (this.chatConfig.debug) console.log(response);

				return response;
			} catch (error) {
				if (error.message === "Request was aborted.") {
					throw new Error("AbortError");
				}

				lastError = error;
				this.currentBackendIndex++; // 失败时也递增索引，切换到下一个后端

				// 如果这是最后一次尝试，则抛出错误
				if (attempt === this.chatConfig.actionGenerator.maxRetries - 1) {
					throw new Error(`所有重试都失败。最后一次错误: ${lastError.message}`);
				}

				// 如果还有重试机会，则继续下一次循环
				if (this.chatConfig.debug) {
					console.log(`第 ${attempt + 1} 次调用失败，切换后端重试...`);
				}

				// 可以添加一个小延迟，避免立即重试
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	}
}

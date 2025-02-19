import pkg from "pg";
const { Pool } = pkg;
import { OpenAI } from "openai";
import dotenv from "dotenv";

dotenv.config();

export class RAGHelper {
	constructor(chatConfig = {}) {
		this.chatConfig = chatConfig;

		// 初始化PostgreSQL连接
		this.pool = new Pool({
			host: chatConfig.postgres.host,
			port: chatConfig.postgres.port,
			database: chatConfig.postgres.database,
			user: chatConfig.postgres.user,
			password: chatConfig.postgres.password,
		});

		// 初始化OpenAI客户端
		this.openai = new OpenAI({
			apiKey: chatConfig.rag.backend.apiKey,
			baseURL: chatConfig.rag.backend.baseURL,
		});

		this.initDatabase();
	}

	async initDatabase() {
		try {
			const client = await this.pool.connect();

			await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

			// 添加 sticker 表
			await client.query(`
                CREATE TABLE IF NOT EXISTS sticker_memories (
                    id SERIAL PRIMARY KEY,
                    sticker_file_unique_id TEXT NOT NULL UNIQUE,
                    sticker_file_id TEXT NOT NULL,
                    description TEXT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_sticker_file_unique_id 
                ON sticker_memories(sticker_file_unique_id);
            `);

			// 消息表结构
			await client.query(`
                CREATE TABLE IF NOT EXISTS chat_memories (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT NOT NULL,
                    message_id BIGINT,  -- telegram消息ID，对于非消息内容可以为null
                    content_type TEXT NOT NULL,  -- 'message', 'search_result', 'reply', 'note' 等
                    text TEXT NOT NULL,
                    metadata JSONB NOT NULL,
                    embedding vector(${process.env.EMBEDDING_TINY_SIZE ? process.env.EMBEDDING_TINY_SIZE : 1536}), -- 这里用的是text-embedding-3-tiny
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                -- 创建索引
                CREATE INDEX IF NOT EXISTS idx_chat_memories_chat_id ON chat_memories(chat_id);
                CREATE INDEX IF NOT EXISTS idx_chat_memories_message_id ON chat_memories(message_id);
                CREATE INDEX IF NOT EXISTS idx_chat_memories_content_type ON chat_memories(content_type);
                CREATE INDEX IF NOT EXISTS idx_chat_memories_created_at ON chat_memories(created_at);
                CREATE INDEX IF NOT EXISTS idx_chat_memories_metadata ON chat_memories USING gin (metadata);
            `);

			// 添加用户记忆表
			await client.query(`
                CREATE TABLE IF NOT EXISTS user_memories (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    content_type TEXT NOT NULL,
                    text TEXT NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}',
                    embedding vector(${process.env.EMBEDDING_LARGE_SIZE ? env.EMBEDDING_LARGE_SIZE : 3072}), -- 这里用的是text-embedding-3-large
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, content_type)  -- 添加组合唯一约束
                );
                
                -- 创建索引
                CREATE INDEX IF NOT EXISTS idx_user_memories_user_id ON user_memories(user_id);
                CREATE INDEX IF NOT EXISTS idx_user_memories_content_type ON user_memories(content_type);
                CREATE INDEX IF NOT EXISTS idx_user_memories_created_at ON user_memories(created_at);
                CREATE INDEX IF NOT EXISTS idx_user_memories_metadata ON user_memories USING gin (metadata);
            `);

			client.release();
			if (this.chatConfig.debug) console.log("数据库初始化完成");
		} catch (error) {
			console.error("数据库初始化错误:", error);
		}
	}

	async getEmbedding(text, model = (process.env.EMBEDDING_TINY_MODEL ? process.env.EMBEDDING_TINY_MODEL : "text-embedding-3-small")) {
		try {
			const response = await this.openai.embeddings.create({
				model: model,
				input: text,
			});
			return `[${response.data[0].embedding.join(",")}]`;
		} catch (error) {
			console.error("获取embedding错误:", error);
			return null;
		}
	}

	// 保存Telegram消息
	async saveMessage(standardizedMsg) {
		try {
			const { chat_id, message_id, text, content_type, metadata } = standardizedMsg;

			if (!text) return false;

			const embedding = await this.getEmbedding(text);
			if (!embedding) return false;

			const client = await this.pool.connect();
			await client.query(
				`INSERT INTO chat_memories 
                (chat_id, message_id, content_type, text, metadata, embedding) 
                VALUES ($1, $2, $3, $4, $5, $6::vector)`,
				[chat_id, message_id, content_type, text, metadata, embedding]
			);
			client.release();

			if (this.chatConfig.debug)
				console.log(`消息已保存 ${chat_id} ${message_id} ${content_type} ${text}`);
			return true;
		} catch (error) {
			console.error("保存消息错误:", error);
			return false;
		}
	}

	// 保存bot的行动
	async saveAction(chatId, text, type, additionalMetadata = {}) {
		try {
			const embedding = await this.getEmbedding(text);
			if (!embedding) return false;

			const metadata = {
				...additionalMetadata,
			};

			const client = await this.pool.connect();
			await client.query(
				`INSERT INTO chat_memories 
                (chat_id, message_id, content_type, text, metadata, embedding) 
                VALUES ($1, $2, $3, $4, $5, $6::vector)`,
				[chatId, null, type, text, metadata, embedding]
			);
			client.release();

			if (this.chatConfig.debug) console.log(`${type}已保存`);
			return true;
		} catch (error) {
			console.error(`保存${type}错误:`, error);
			return false;
		}
	}

	async getMessage(messageId) {
		const client = await this.pool.connect();
		const result = await client.query("SELECT * FROM chat_memories WHERE message_id = $1", [
			messageId,
		]);
		client.release();
		return result.rows[0];
	}

	// 获取消息上下文（基于message_id的前后文）
	async getMessageContext(chatId, messageId, limit = 3) {
		try {
			const client = await this.pool.connect();

			const result = await client.query(
				`WITH target_message AS (
                    SELECT id, created_at
                    FROM chat_memories
                    WHERE chat_id = $1 AND message_id = $2
                    LIMIT 1
                )
                (
                    SELECT cm.text, cm.metadata, cm.content_type, cm.message_id,
                           cm.created_at, 'before' as position
                    FROM chat_memories cm, target_message
                    WHERE cm.chat_id = $1
                    AND cm.id < target_message.id
                    ORDER BY cm.id DESC
                    LIMIT $3
                )
                UNION ALL
                (
                    SELECT cm.text, cm.metadata, cm.content_type, cm.message_id,
                           cm.created_at, 'current' as position
                    FROM chat_memories cm
                    WHERE cm.chat_id = $1
                    AND message_id = $2
                )
                UNION ALL
                (
                    SELECT cm.text, cm.metadata, cm.content_type, cm.message_id,
                           cm.created_at, 'after' as position
                    FROM chat_memories cm, target_message
                    WHERE cm.chat_id = $1
                    AND cm.id > target_message.id
                    ORDER BY cm.id ASC
                    LIMIT $3
                )
                ORDER BY created_at`,
				[chatId, messageId, limit]
			);

			client.release();
			return result.rows;
		} catch (error) {
			console.error("获取消息上下文错误:", error);
			return [];
		}
	}

	// 语义搜索（支持多种内容类型）
	async searchSimilarContent(chatId, queryText, options = {}) {
		const {
			limit = 5,
			contentTypes = [],
			timeWindow = "99 years",
			withContext = 0, // 新增参数，默认为0表示不获取上下文
		} = options;

		try {
			const queryEmbedding = await this.getEmbedding(queryText);
			if (!queryEmbedding) return [];

			const client = await this.pool.connect();
			const result = await client.query(
				`SELECT 
                    text,
                    metadata,
                    content_type,
                    message_id,
                    created_at,
                    embedding <-> $1::vector as distance
                FROM chat_memories
                WHERE chat_id = $2
                AND (ARRAY_LENGTH($3::text[], 1) IS NULL OR content_type = ANY($3))
                AND created_at > NOW() - $4::interval
                ORDER BY embedding <-> $1::vector
                LIMIT $5`,
				[queryEmbedding, chatId, contentTypes, timeWindow, limit]
			);

			// 如果需要上下文，则为每个结果获取上下文
			if (withContext > 0) {
				const resultsWithContext = await Promise.all(
					result.rows.map(async (row) => {
						if (row.message_id || row.metadata.related_message_id) {
							const context = await this.getMessageContext(
								chatId,
								row.message_id || row.metadata.related_message_id,
								withContext
							);
							return context;
						}
						return [row];
					})
				);
				client.release();
				return resultsWithContext.flat(1);
			}

			client.release();
			return result.rows;
		} catch (error) {
			console.error("搜索相似内容错误:", error);
			return [];
		}
	}

	/**
	 * 更新已存在的消息
	 * @param {Object} standardizedMsg - 标准化的消息对象
	 * @returns {Promise<boolean>} 更新是否成功
	 */
	async updateMessage(standardizedMsg) {
		try {
			const { chat_id, message_id, text, content_type, metadata } = standardizedMsg;

			if (!text) return false;

			// 获取新的 embedding
			const embedding = await this.getEmbedding(text);
			if (!embedding) return false;

			const client = await this.pool.connect();

			// 使用 chat_id 和 message_id 定位并更新消息
			await client.query(
				`UPDATE chat_memories 
                SET text = $1,
                    metadata = $2,
                    embedding = $3::vector,
                    content_type = $4
                WHERE chat_id = $5 AND message_id = $6`,
				[text, metadata, embedding, content_type, chat_id, message_id]
			);

			client.release();

			if (this.chatConfig.debug) console.log("消息已更新");
			return true;
		} catch (error) {
			console.error("更新消息错误:", error);
			return false;
		}
	}

	/**
	 * 删除消息
	 * @param {number} chatId - 聊天ID
	 * @param {number} messageId - 消息ID
	 * @returns {Promise<boolean>} 删除是否成功
	 */
	async deleteMessage(chatId, messageId) {
		try {
			const client = await this.pool.connect();

			await client.query(
				`DELETE FROM chat_memories 
                WHERE chat_id = $1 AND message_id = $2`,
				[chatId, messageId]
			);

			client.release();

			if (this.chatConfig.debug) console.log("消息已删除");
			return true;
		} catch (error) {
			console.error("删除消息错误:", error);
			return false;
		}
	}

	// 获取 sticker 描述
	async getStickerDescription(stickerFileUniqueId, stickerFileId) {
		try {
			const client = await this.pool.connect();

			// 尝试获取现有描述
			const existingResult = await client.query(
				"SELECT description FROM sticker_memories WHERE sticker_file_unique_id = $1",
				[stickerFileUniqueId]
			);

			if (existingResult.rows.length > 0) {
				client.release();
				return existingResult.rows[0].description;
			}

			client.release();
			return null;
		} catch (error) {
			console.error("获取sticker描述错误:", error);
			return null;
		}
	}

	async saveStickerDescription(stickerFileUniqueId, stickerFileId, description, metadata = {}) {
		try {
			const client = await this.pool.connect();

			await client.query(
				`INSERT INTO sticker_memories 
                (sticker_file_unique_id, sticker_file_id, description, metadata) 
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (sticker_file_unique_id) 
                DO UPDATE SET description = $3, metadata = $4`,
				[stickerFileUniqueId, stickerFileId, description, metadata]
			);

			client.release();
			return true;
		} catch (error) {
			console.error("保存sticker描述错误:", error);
			return false;
		}
	}

	async updateUserMemory(userId, text, contentType = "memory") {
		try {
			const embedding = await this.getEmbedding(text, process.env.EMBEDDING_LARGE_MODEL ? process.env.EMBEDDING_LARGE_MODEL : "text-embedding-3-large");
			if (!embedding) return false;

			const client = await this.pool.connect();

			await client.query(
				`INSERT INTO user_memories 
				(user_id, content_type, text, embedding, updated_at) 
				VALUES ($1, $2, $3, $4::vector, CURRENT_TIMESTAMP)
				ON CONFLICT (user_id, content_type) 
				DO UPDATE SET 
					text = $3,
					embedding = $4::vector,
					updated_at = CURRENT_TIMESTAMP`,
				[userId, contentType, text, embedding]
			);

			client.release();
			return true;
		} catch (error) {
			console.error("更新用户记忆错误:", error);
			return false;
		}
	}

	async getUserMemory(userId, contentType = "memory") {
		try {
			const client = await this.pool.connect();
			const result = await client.query(
				`SELECT text, created_at, updated_at 
				FROM user_memories 
				WHERE user_id = $1 AND content_type = $2 
				LIMIT 1`,
				[userId, contentType]
			);
			client.release();

			return result.rows.length > 0 ? result.rows[0] : null;
		} catch (error) {
			console.error("获取用户记忆错误:", error);
			return null;
		}
	}
}

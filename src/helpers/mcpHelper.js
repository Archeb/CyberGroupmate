import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export class MCPHelper {
	constructor() {
		// 存储服务器连接信息
		this.servers = new Map(); // key: serverPath/url, value: { mcp, transport, config, tools }
		// 按服务器名称存储工具
		this.toolsByServer = new Map(); // key: serverName, value: Array<tools>
	}

	/**
	 * 连接到 MCP 服务器
	 * @param {Object} serverConfig 服务器配置
	 * @param {string} serverConfig.name 服务器名称
	 * @param {string} serverConfig.description 服务器描述
	 * @param {string} serverConfig.type 服务器类型 ('stdio' | 'sse')
	 * @param {string} [serverConfig.path] stdio 服务器的脚本路径
	 * @param {string} [serverConfig.url] sse 服务器的 URL
	 * @param {Object} [serverConfig.env] 环境变量配置
	 */
	async connectToServer(serverConfig) {
		const { name, description, type, env = {} } = serverConfig;
		const serverKey = type === "sse" ? serverConfig.url : serverConfig.path;

		try {
			// 如果已经连接过这个服务器，直接返回其工具列表
			if (this.servers.has(serverKey)) {
				return this.servers.get(serverKey).tools;
			}

			const mcp = new Client(
				{
					name: "mcp-client-cli",
					version: "1.0.0",
				},
				{
					capabilities: {},
				}
			);

			let transport;
			if (type === "stdio") {
				const { path: serverPath } = serverConfig;

				// 解析命令和参数
				const parts = serverPath.split(" ");
				const command = parts[0];
				const args = parts.slice(1);

				// 合并进程环境变量和配置的环境变量
				const processEnv = { ...process.env };
				const serverEnv = { ...processEnv, ...env };

				transport = new StdioClientTransport({
					command,
					args,
					env: serverEnv,
				});
			} else if (type === "sse") {
				const { url } = serverConfig;
				if (!url) {
					throw new Error("SSE server URL is required");
				}
				// SSE 服务器的环境变量需要通过其他方式配置（如服务器端配置）
				transport = new SSEClientTransport(new URL(url));
			} else {
				throw new Error(`Unsupported server type: ${type}`);
			}

			await mcp.connect(transport);

			const toolsResult = await mcp.listTools();
			const tools = toolsResult.tools.map((tool) => ({
				type: "function",
				function: {
					name: `${name}--${tool.name}`,
					description: `${tool.description}\n来自服务器: ${description}`,
					parameters: tool.inputSchema,
				},
				serverKey, // 保存服务器标识用于执行时查找
				serverName: name, // 保存服务器名称
			}));

			// 保存服务器信息
			this.servers.set(serverKey, {
				mcp,
				transport,
				config: serverConfig,
				tools,
			});

			// 按服务器名称保存工具
			this.toolsByServer.set(name, tools);

			console.log(
				`Connected to MCP ${type} server "${name}" with tools:`,
				tools.map((tool) => tool.function.name)
			);

			return tools;
		} catch (e) {
			console.error(`Failed to connect to MCP server ${name} (${serverKey}):`, e);
			throw e;
		}
	}

	/**
	 * 获取按服务器组织的工具列表
	 * @returns {Object} 按服务器组织的工具列表
	 */
	getToolsByServer() {
		const result = {};
		for (const [serverName, tools] of this.toolsByServer) {
			result[serverName] = tools;
		}
		return result;
	}

	/**
	 * 获取指定服务器的所有工具
	 * @param {string} serverName 服务器名称
	 * @returns {Array} 该服务器的工具列表
	 */
	getServerTools(serverName) {
		return this.toolsByServer.get(serverName) || [];
	}

	/**
	 * 获取所有工具的扁平列表
	 * @returns {Array} 所有工具的列表
	 */
	getAllTools() {
		const allTools = [];
		for (const tools of this.toolsByServer.values()) {
			allTools.push(...tools);
		}
		return allTools;
	}

	async executeToolCall(name, params) {
		const [serverName, toolName] = name.split("--");

		// 在该服务器中查找工具
		const serverTools = this.toolsByServer.get(serverName) || [];
		const tool = serverTools.find((t) => t.function.name === name);

		if (!tool) {
			throw new Error(`Tool ${name} not found`);
		}

		// 获取对应的服务器连接
		const server = this.servers.get(tool.serverKey);
		if (!server) {
			throw new Error(`Server for tool ${name} not connected`);
		}

		try {
			const result = await server.mcp.callTool({ name: toolName, arguments: params });
			return {
				status: "success",
				action: name,
				serverName: tool.serverName,
				result,
			};
		} catch (error) {
			console.error(`MCP tool ${name} execution failed:`, error);
			throw error;
		}
	}

	async disconnect() {
		for (const [serverKey, server] of this.servers) {
			try {
				if (server.transport) {
					await server.transport.close();
				}
			} catch (error) {
				console.error(`Error disconnecting from ${serverKey}:`, error);
			}
		}
		this.servers.clear();
		this.toolsByServer.clear();
	}
}

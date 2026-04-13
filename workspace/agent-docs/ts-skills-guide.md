# TS Skills 创建指南

创建一个 TS Skill 需要三步：

## 1. 创建目录和入口文件

```
workspace/skills/<name>/index.ts
workspace/skills/<name>/<name>.d.ts  (可选，用于 API 文档)
```

## 2. 编写 index.ts

导出一个对象，包含你的方法（可以用 async）：

```typescript
// workspace/skills/weather/index.ts
export const weather = {
    current: async (city: string) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        return await res.json();
    },
    forecast: async (city: string, days: number = 3) => {
        const res = await fetch(`https://wttr.in/${city}?format=j1`);
        const data = await res.json();
        return data.weather?.slice(0, days);
    }
};
```

导出约定：
- 优先使用 `export const <name> = { ... }`（推荐）
- 或 `export default { ... }`
- 导出的对象名就是你在代码中调用的变量名

## 3. 编写 .d.ts（可选但推荐）

类型定义文件让 API 文档对你自动可见：

```typescript
// workspace/skills/weather/weather.d.ts
/**
 * 天气查询 Skill
 */
declare const weather: {
    /** 获取当前天气 */
    current(city: string): Promise<object>;
    /** 获取未来天气预报 */
    forecast(city: string, days?: number): Promise<object[]>;
};
```

## 4. 热重载

创建完文件后，调用 `skills.reload()` 热重载。新 Skill 会立即可用。

## 安装依赖

如果需要 npm 包：
```javascript
await skills.npmInstall(["cheerio", "axios"]);
```
然后在 index.ts 中 import 使用。

## CLI 工具包装示例

```typescript
// workspace/skills/yt-dlp/index.ts
import { execSync } from "node:child_process";

export const ytdlp = {
    info: (url: string) =>
        JSON.parse(execSync(`yt-dlp -j "${url}"`, { encoding: "utf-8" })),
    download: (url: string, output: string) =>
        execSync(`yt-dlp -o "${output}" "${url}"`, { encoding: "utf-8" }),
};
```

## 注意事项

- Skill 的所有文件都应该在 `workspace/skills/<name>/` 下
- 不要使用相对路径引用 workspace 外的文件
- 方法可以是同步或异步的
- index.ts 中可以 import `node:` 内置模块和 workspace/skills/node_modules 中的包

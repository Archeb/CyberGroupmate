/**
 * 飞书表情（emoji）语义化。
 *
 * 飞书富文本的 `emotion` 节点、消息表态事件、纯文本消息里的表情，都只带一个
 * `emoji_type` 字符串。它有两种形态：
 *
 * 1. 官方枚举名，如 `THUMBSUP`、`SPITBLOOD`；
 * 2. 客户端表情名，如 `Lark_Emoji_FingerHeart_0`。
 *
 * 两者都能对应到飞书客户端的中文名（`[赞]`、`[比心]`）。自定义表情则是纯数字 ID，
 * 既没有图片资源也没有公开映射，只能原样透传。
 *
 * 数据来源：飞书客户端 EmojiData 对照表。
 */

type FeishuEmojiEntry = readonly [type: string, clientName: string, label: string];

const FEISHU_EMOJI_TABLE: readonly FeishuEmojiEntry[] = [
    ["18X", "Lark_Emoji_18x_0", "18禁"],
    ["2021", "2021", "2021"],
    ["ANGRY", "Lark_Emoji_Angry_0", "发怒"],
    ["APPLAUSE", "Lark_Emoji_Applaud_0", "鼓掌"],
    ["ATTENTION", "Lark_Emoji_Attention_0", "来看我"],
    ["AWESOME", "Lark_Emoji_Awesome_0", "666"],
    ["AWESOMEN", "Awesomen", "牛"],
    ["BEAR", "Lark_Emoji_Bear_0", "熊吉"],
    ["BEER", "Lark_Emoji_Beer_0", "啤酒"],
    ["BETRAYED", "Lark_Emoji_Betrayed_0", "绿帽子"],
    ["BIGKISS", "Lark_Emoji_BigKiss_0", "如花"],
    ["BLACKFACE", "Lark_Emoji_BlackFace_0", "黑脸"],
    ["BLUBBER", "Lark_Emoji_Blubber_0", "快哭了"],
    ["BLUSH", "Lark_Emoji_Grin_0", "呲牙"],
    ["BOMB", "Lark_Emoji_Bomb_0", "炸弹"],
    ["BULL", "Bull", "公牛"],
    ["CAKE", "Lark_Emoji_Cake_0", "蛋糕"],
    ["CALF", "Calf", "小牛"],
    ["CANDIEDHAWS", "Candiedhaws", "冰糖葫芦"],
    ["CHUCKLE", "Lark_Emoji_Chuckle_0", "偷笑"],
    ["CLAP", "Lark_Emoji_Clap_0", "小鼓掌"],
    ["CLEAVER", "Lark_Emoji_Cleaver_0", "刀"],
    ["COMFORT", "Lark_Emoji_Comfort_0", "摸头"],
    ["CRAZY", "Lark_Emoji_Crazy_0", "抓狂"],
    ["CRY", "Lark_Emoji_Cry_0", "泣不成声"],
    ["CUCUMBER", "Lark_Emoji_Cucumber_0", "胡瓜"],
    ["DETERGENT", "Lark_Emoji_Detergent_0", "去污粉"],
    ["DIZZY", "Lark_Emoji_Dizzy_0", "晕"],
    ["DONE", "Done", "完成"],
    ["DONNOTGO", "Lark_Emoji_DonnotGo_0", "紫薇别走"],
    ["DROOL", "Lark_Emoji_Drool_0", "爱慕"],
    ["DROWSY", "Lark_Emoji_Drowsy_0", "困"],
    ["DULL", "Lark_Emoji_Dull_0", "呆无辜"],
    ["DULLSTARE", "Lark_Emoji_DullStare_0", "周冬雨的凝视"],
    ["EATING", "Lark_Emoji_Eating_0", "吃瓜群众"],
    ["EMBARRASSED", "Lark_Emoji_Embarrassed_0", "尬笑"],
    ["ENOUGH", "Lark_Emoji_Enough_0", "我想静静"],
    ["ERROR", "Lark_Emoji_Errr_0", "黑线"],
    ["EYESCLOSED", "Lark_Emoji_EyesClosed_0", "不看"],
    ["FACEPALM", "Lark_Emoji_Facepalm_0", "捂脸"],
    ["FINGERHEART", "Lark_Emoji_FingerHeart_0", "比心"],
    ["FIRECRACKER", "Firecracker", "爆竹"],
    ["FIREWORKS", "Fireworks", "烟花"],
    ["FISTBUMP", "Lark_Emoji_FistBump_0", "碰拳"],
    ["FOLLOWME", "Lark_Emoji_FollowMe_0", "互粉"],
    ["FORTUNE", "Fortune", "发"],
    ["FROWN", "Lark_Emoji_Frown_0", "皱眉"],
    ["GIFT", "Lark_Emoji_Gift_0", "礼物"],
    ["GLANCE", "Lark_Emoji_Glance_0", "看"],
    ["GOODJOB", "Lark_Emoji_GoodJob_0", "给力"],
    ["HAMMER", "Lark_Emoji_Hammer_0", "敲打"],
    ["HAUGHTY", "Lark_Emoji_haughty_0", "酷拽"],
    ["HEADSET", "Lark_Emoji_Headset_0", "听歌"],
    ["HEART", "Lark_Emoji_Heart_0", "爱心"],
    ["HEARTBROKEN", "Lark_Emoji_HeartBroken_0", "伤心"],
    ["HIGHFIVE", "Lark_Emoji_HighFive_0", "击掌"],
    ["HUG", "Lark_Emoji_Hug_0", "求抱抱"],
    ["HUSKY", "Lark_Emoji_Husky_0", "翻白眼"],
    ["INNOCENTSMILE", "Lark_Emoji_InnocentSmile_0", "马思纯的微笑"],
    ["JIAYI", "[+1]", "+1"],
    ["JOYFUL", "Lark_Emoji_Joyful_0", "笑"],
    ["KISS", "Lark_Emoji_Kiss_0", "吻"],
    ["LAUGH", "Lark_Emoji_Laugh_0", "大笑"],
    ["LGTM", "LGTM", "LGTM"],
    ["LIPS", "Lark_Emoji_Lips_0", "kiss"],
    ["LOL", "Lark_Emoji_Lol_0", "笑哭"],
    ["LOOKDOWN", "Lark_Emoji_LookDown_0", "鄙视"],
    ["LOVE", "Lark_Emoji_Love_0", "送心"],
    ["LUCK", "Luck", "福"],
    ["MONEY", "Lark_Emoji_Money_0", "钱"],
    ["MUSCLE", "Lark_Emoji_Fighting_0", "加油"],
    ["NOSEPICK", "Lark_Emoji_NosePick_0", "抠鼻"],
    ["OBSESSED", "Lark_Emoji_Obsessed_0", "舔屏"],
    ["OK", "Lark_Emoji_OK_0", "OK"],
    ["OKR", "OKR", "OKR"],
    ["PARTY", "Lark_Emoji_Party_0", "撒花"],
    ["PETRIFIED", "Lark_Emoji_Petrified_0", "石化"],
    ["POOP", "Lark_Emoji_Poop_0", "屎"],
    ["PRAISE", "Lark_Emoji_Praise_0", "强"],
    ["PROUD", "Lark_Emoji_Proud_0", "得意"],
    ["PUKE", "Lark_Emoji_Puke_0", "吐"],
    ["RAINBOWPUKE", "Lark_Emoji_RainbowPuke_0", "吐彩虹"],
    ["REDPACKET", "Redpacket", "红包"],
    ["ROSE", "Lark_Emoji_Rose_0", "玫瑰"],
    ["SALUTE", "Salute", "抱拳"],
    ["SCOWL", "Lark_Emoji_Scowl_0", "惊呆"],
    ["SHAKE", "Lark_Emoji_Shake_0", "握手"],
    ["SHHH", "Lark_Emoji_Shhh_0", "嘘"],
    ["SHOCKED", "Lark_Emoji_Shocked_0", "震惊"],
    ["SHOWOFF", "Lark_Emoji_ShowOff_0", "酷"],
    ["SHY", "Lark_Emoji_Shy_0", "害羞"],
    ["SICK", "Lark_Emoji_Sick_0", "雾霾"],
    ["SILENT", "Lark_Emoji_Silent_0", "闭嘴"],
    ["SKULL", "Lark_Emoji_Skull_0", "骷髅"],
    ["SLAP", "Lark_Emoji_Slap_0", "打脸"],
    ["SLEEP", "Lark_Emoji_Sleep_0", "鼾睡"],
    ["SLIGHT", "Lark_Emoji_Slight_0", "白眼"],
    ["SMART", "Lark_Emoji_Smart_0", "机智"],
    ["SMILE", "Lark_Emoji_Smile_0", "微笑"],
    ["SMIRK", "Lark_Emoji_Smirk_0", "奸笑"],
    ["SMOOCH", "Lark_Emoji_Smooch_0", "飞吻"],
    ["SMUG", "Lark_Emoji_Smug_0", "撇嘴"],
    ["SOB", "Lark_Emoji_Sob_0", "流泪"],
    ["SPEECHLESS", "Lark_Emoji_Speechless_0", "擦汗"],
    ["SPITBLOOD", "Lark_Emoji_SpitBlood_0", "吐血"],
    ["STRIVE", "Lark_Emoji_Strive_0", "奋斗"],
    ["SWEAT", "Lark_Emoji_Sweat_0", "汗"],
    ["TEARS", "Lark_Emoji_Tears_0", "泪奔"],
    ["TEASE", "Lark_Emoji_Tease_0", "做鬼脸"],
    ["TERROR", "Lark_Emoji_Terror_0", "恐惧"],
    ["THANKS", "Lark_Emoji_Thanks_0", "谢谢"],
    ["THINKING", "Lark_Emoji_Thinking_0", "思考"],
    ["THUMBSUP", "Lark_Emoji_Thumbsup_0", "赞"],
    ["TOASTED", "Lark_Emoji_Toasted_0", "衰"],
    ["TONGUE", "Lark_Emoji_Tongue_0", "吐舌"],
    ["TRICK", "Lark_Emoji_Trick_0", "憨笑"],
    ["TV", "TV", "电视"],
    ["UPPERLEFT", "Lark_Emoji_UpperLeft_0", "左上"],
    ["WAIL", "Lark_Emoji_Wail_0", "大哭"],
    ["WAVE", "Lark_Emoji_Wave_0", "再见"],
    ["WELLDONE", "Lark_Emoji_WellDone_0", "V5"],
    ["WHAT", "Lark_Emoji_What_0", "what"],
    ["WHIMPER", "Lark_Emoji_Whimper_0", "可怜"],
    ["WINK", "Lark_Emoji_Wink_0", "可爱"],
    ["WITTY", "Lark_Emoji_Witty_0", "灵光一闪"],
    ["WOW", "Lark_Emoji_Wow_0", "惊喜"],
    ["WRONGED", "Lark_Emoji_Wronged_0", "委屈"],
    ["XBLUSH", "Lark_Emoji_Blush_0", "红脸"],
    ["YAWN", "Lark_Emoji_Yawn_0", "哈欠"],
    ["YEAH", "Lark_Emoji_Yeah_0", "耶"],
];

/** 纯数字 ID：租户自定义表情，飞书不提供名称也不提供图片资源。 */
const CUSTOM_EMOJI_PATTERN = /^\d{6,}$/;
/** `Lark_Emoji_FingerHeart_0` 形态的客户端表情名。 */
const CLIENT_EMOJI_PATTERN = /^Lark_Emoji_([A-Za-z0-9]+)_\d+$/;

/** 官方枚举名与客户端表情名共用一张查找表：两者的取值域不重叠，归一化后即可直接命中。 */
const labelByKey = new Map<string, string>();

/** 归一化时保留 `+`，否则 `JIAYI` 的客户端名 `[+1]` 会退化成 `1` 并与数字 ID 混淆。 */
function emojiKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9+]/g, "");
}

for (const [type, clientName, label] of FEISHU_EMOJI_TABLE) {
    for (const key of [emojiKey(type), emojiKey(clientName)]) {
        if (key && !labelByKey.has(key)) labelByKey.set(key, label);
    }
}

/** 把 `Lark_Emoji_FingerHeart_0` 拆成可读词，如 `FingerHeart`。 */
function splitClientEmojiName(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
}

/** 查表得到中文名；查不到时返回 undefined。 */
function emojiLabel(type: string): string | undefined {
    const label = labelByKey.get(emojiKey(type));
    if (label) return label;
    const clientMatch = CLIENT_EMOJI_PATTERN.exec(type);
    return clientMatch ? splitClientEmojiName(clientMatch[1]) : undefined;
}

/**
 * 取表情的人类可读名字。
 *
 * 识别顺序：官方枚举名 / 客户端表情名 → `Lark_Emoji_Xxx_0` 拆词 → 自定义数字 ID → 原样返回。
 *
 * - 已知表情：「比心」
 * - 自定义数字 ID：`自定义表情 7600608696380558562`
 * - 空值：空字符串
 */
export function feishuEmojiName(emojiType: string): string {
    const type = emojiType.trim();
    if (!type) return "";
    return emojiLabel(type) ?? (CUSTOM_EMOJI_PATTERN.test(type) ? `自定义表情 ${type}` : type);
}

/**
 * 渲染成模型可读的表情标签。
 *
 * - 已知表情：`[🎭 飞书表情:比心]`
 * - 自定义数字 ID：`[🎭 飞书表情:7600608696380558562]`
 * - 空值：`[🎭 飞书表情]`
 */
export function formatFeishuEmoji(emojiType: string): string {
    const type = emojiType.trim();
    return type ? `[🎭 飞书表情:${emojiLabel(type) ?? type}]` : "[🎭 飞书表情]";
}

/**
 * 渲染表态事件的文案，风格与 OneBot 的 `[👉 戳一戳]` 合成事件一致。
 *
 * - 新增：`[👍 表态] 给消息点了「赞」`
 * - 撤销：`[👍 表态] 撤回了「赞」`
 */
export function formatFeishuReaction(action: "added" | "removed", emojiType: string): string {
    const name = feishuEmojiName(emojiType) || "表情";
    return action === "added"
        ? `[👍 表态] 给消息点了「${name}」`
        : `[👍 表态] 撤回了「${name}」`;
}

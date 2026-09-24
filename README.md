# cy-chat

字卡 & 表情包云端仓库。往仓库里丢文件就会**自动识别、校验、去重、归类和登记**，其他项目只需接入云端端点即可自动获取数据。

---

## ⚠️ 破坏性变更（v1 → v2）

本次升级把图片从平铺改为**按分类子目录存放**，因此图片路径变了：

| | v1 | v2 |
|---|---|---|
| 图片路径 | `Meme/images/xxx.jpg` | `Meme/images/**reactions**/xxx.jpg` |
| `meme.json` 版本 | `1.0.0` | `2.0.0` |

**已经接入旧路径的客户端必须同步更新**：
- 如果按 `meme.json` 里的 `url` 字段取图 → **无需改动**，url 字段已是新路径。
- 如果自己拼接路径（如 `raw.githubusercontent.com/.../Meme/images/` + 文件名） → **需要改**，中间多了一层分类目录。

同时，图片条目新增了 `width` / `height` / `bytes` / `format` 字段（向后兼容，只读 `id/name/url/tags` 的客户端不受影响）。

---

## 仓库结构

```
cy-chat/
├── Meme/
│   ├── images/
│   │   ├── reactions/      # 反应表情
│   │   ├── emotions/       # 情绪表情（预设空分类）
│   │   ├── interactions/   # 互动表情（预设空分类）
│   │   ├── stickers/       # 贴图（预设空分类）
│   │   └── <任意新目录>/    # 想加分类就直接建目录，名字随你
│   └── meme.json           # 表情包索引（自动生成，勿手改）
├── Word/
│   ├── words/              # 字卡文本源文件（每行一条）
│   │   ├── customReplies.txt
│   │   ├── pokes.txt
│   │   ├── statuses.txt
│   │   └── <任意新名字>.txt # 想加分类就直接建 txt，文件名随你
│   └── word.json           # 字卡索引（自动生成，勿手改）
├── scripts/
│   ├── lib/identify.mjs    # 识别核心库（类型嗅探 / 尺寸 / 去重 / 分类）
│   ├── sync-index.mjs      # 同步引擎（供 CI 与上传接口共用）
│   └── server.mjs          # 上传接口
└── .github/workflows/sync-index.yml
```

> `meme.json` 和 `word.json` 是**自动生成**的产物。手工编辑会在下次同步时被覆盖 —— 要加内容请加源文件。
>
> 分类是**动态发现**的：脚本每次都会重新扫描目录，磁盘上出现的文件夹名就是合法分类。所以「预设分类」只是提供了中文标签和固定 ID 前缀，并不是白名单。

---

## 怎么用：两条上传入口

**一句话：把文件放进对应文件夹就行，其余全自动。** 分类不写死 —— **目录名就是分类**，你想加一个新分类，直接在网页上新建一个文件夹，不用改任何代码。

### 入口一：往仓库丢文件（GitHub 网页拖拽上传 / git push）

直接在 GitHub 网页上把文件拖进目标文件夹并提交即可，机器人会自动识别、校验、去重、登记、写回 JSON。

**加表情包** —— 图片放在 `Meme/images/<分类名>/` 下，分类名由你自己定：

```
Meme/images/reactions/新表情.jpg        → 分类 reactions（反应表情）
Meme/images/stickers/星星.png           → 分类 stickers（贴图）
Meme/images/斗图/我来啦.png              → 分类「斗图」（新分类，自动出现）
Meme/images/funny/哈哈哈.gif            → 分类 funny（新分类，自动出现）
```

**加字卡** —— 在 `Word/words/` 下新建或追加一个 `.txt`，**文件名就是分类名**：

```
Word/words/customReplies.txt   → 分类 customReplies（自定义回复）
Word/words/pokes.txt           → 分类 pokes（戳一戳）
Word/words/greetings.txt       → 分类 greetings（新分类，自动出现）
```

文件格式：一行一条，空行忽略，`#` 开头的行是注释。

```
# 这一行是注释，不会被收录
你这个冷漠无情的人
我们之间的距离好像忽远又忽近
```

**关于分类，记住三条就够了：**

1. **新分类 = 新文件夹 / 新 txt**，不需要改代码、不需要提 issue。
2. **放在新文件夹里的图不会被搬走**。分类就是你放的那个目录，脚本只在两种情况下动文件：图片平铺在 `Meme/images/` 根目录（会归入默认分类 `reactions`），以及内容完全重复的冗余文件（会删掉重复的那份）。
3. **文件夹删了、分类就消失**。动态分类一旦空了会被自动清理；预设的四个空分类（`emotions` / `interactions` / `stickers`）会保留，作为固定槽位。

**什么时候会跑：**

| 触发方式 | 时机 |
|---|---|
| push | 任何人提交后**立刻**跑 |
| 手动 | 仓库 Actions 页面点 **Run workflow** |
| 定时兜底 | **每小时**自动扫一遍（即使上面两条都没生效，最多一小时也会自动补齐） |

> 定时任务来自 `schedule`。如果哪天发现索引没跟上，不用自己动手，等整点自动跑；想立刻生效就去 Actions 页面点一下 **Run workflow**。

### 入口二：客户端 App 调接口上传

启动接收服务：

```bash
node scripts/server.mjs
```

接口：

```bash
# 上传表情包（body 为文件原始字节）
curl -X POST "http://127.0.0.1:8787/upload/meme?name=点赞.gif&category=reactions" \
     --data-binary "@/path/to/点赞.gif"

# 上传字卡（body 为纯文本，每行一条）
curl -X POST "http://127.0.0.1:8787/upload/word?category=customReplies" \
     --data-binary $'新文案一\n新文案二'

# 健康检查
curl http://127.0.0.1:8787/health
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `REPO_DIR` | 脚本上级目录 | 仓库根目录 |
| `UPLOAD_TOKEN` | 空 | 设置后请求需带 `X-Upload-Token` 头 |
| `AUTO_PUSH` | `true` | 设为 `false` 只本地提交、不推送 |
| `MAX_UPLOAD_MB` | `10` | 单文件大小上限 |
| `GIT_BOT_NAME` | `cy-chat-bot` | 提交者名字 |
| `GIT_BOT_EMAIL` | `cy-chat-bot@users.noreply.github.com` | 提交者邮箱 |

> **部署提示**
>
> 1. 服务端需要持有仓库的写权限（部署机器上配置好 git 凭据 / deploy key）。
> 2. **提交身份不用在服务器上配全局 git 用户**，接口会用 `GIT_BOT_NAME` / `GIT_BOT_EMAIL` 显式指定，默认值可直接用。
> 3. 接口内部做了串行排队，同一个进程不会并发提交；如果要多实例部署，请在负载均衡层做单实例路由或加分布式锁。
> 4. 提交失败（网络、权限、冲突）**不会**让上传报错。此时文件和索引已经更新，响应里的 `commit.error` 会说明原因，内容不会丢。

---

## 自动识别做了什么

每次同步都是一次「确定性识别」，不联网、不调模型、结果可复现：

| 能力 | 说明 |
|---|---|
| **真实类型嗅探** | 读文件头判定格式，不信任扩展名。把 `.exe` 改名成 `.jpg` 会被拒收；JPEG 存成 `.heif` 会被自动改为 `.jpg` 并告警 |
| **尺寸解析** | 提取图片真实宽高，写入条目的 `width` / `height` |
| **内容去重** | 按 SHA1 比对，同一份图只保留一个；冗余文件删除并在报告中列出 |
| **分类发现** | 目录名即分类，每次同步重新扫描。**新分类无需改代码**，放进去就自动出现在 JSON 里 |
| **ID 分配** | 新文件续号（`meme_0079`、`reply_1522`）；已有条目 ID 保持稳定不变；动态字卡分类按分类名推导前缀（`greetings.txt` → `greetings_0001`） |
| **孤儿清理** | 索引里有、磁盘上没了的条目会被清除；动态分类空了会连分类一起清掉 |
| **格式兼容告警** | HEIC 等浏览器无法直接渲染的格式会被标记提醒 |
| **字卡去重** | 跨分类查重，已存在的文案不会重复收录 |

---

## 云端端点

| 端点 | 说明 |
|------|------|
| `Word/word.json` | 字卡数据（自定义回复、戳一戳、状态等） |
| `Meme/meme.json` | 表情包索引（分类、图片 URL、标签） |

```javascript
// 获取字卡
const res = await fetch('https://your-repo-url/Word/word.json');
const wordData = await res.json();

// 获取表情包
const memeRes = await fetch('https://your-repo-url/Meme/meme.json');
const memeData = await memeRes.json();
// 图片地址：把 url 字段拼到仓库 raw 地址后面即可
// const imgUrl = `${RAW_BASE}/${item.url}`;
```

## 数据格式

### word.json

```json
{
  "name": "cy-chat Word Cards",
  "version": "1.0.0",
  "description": "字卡云端数据 - 自定义回复 & 互动内容",
  "updatedAt": "2026-07-11T17:57:47.376Z",
  "generatedBy": "scripts/sync-index.mjs",
  "categories": {
    "customReplies": {
      "label": "自定义回复",
      "description": "触发关键词后自动回复的文字内容",
      "items": [
        { "id": "reply_0001", "text": "你这个冷漠无情的人", "tags": [] }
      ]
    }
  }
}
```

### meme.json

```json
{
  "name": "cy-chat Meme Pack",
  "version": "2.0.0",
  "description": "表情包云端数据 - 图片表情 & 贴图",
  "updatedAt": "2026-09-25T...",
  "generatedBy": "scripts/sync-index.mjs",
  "categories": {
    "reactions": {
      "label": "反应表情",
      "description": "日常反应类表情包",
      "items": [
        {
          "id": "meme_0001",
          "name": "点赞",
          "url": "Meme/images/reactions/xxx.jpg",
          "tags": [],
          "width": 300,
          "height": 300,
          "bytes": 8365,
          "format": "jpeg"
        }
      ]
    }
  }
}
```

`width` / `height` / `bytes` / `format` 是 v2 新增的机械识别产物，可用于按尺寸筛选、预估加载体积、跳过不支持格式。

---

## 本地命令

```bash
node scripts/sync-index.mjs                    # 试运行：只报告，不改动任何文件
node scripts/sync-index.mjs --write            # 实际写入（改 JSON、移动图片、删重复）
node scripts/sync-index.mjs --write --no-move  # 只更新 JSON，不移动文件
node scripts/sync-index.mjs --out=report.txt   # 报告写入文件
node scripts/sync-index.mjs --json             # 附带机器可读报告
```

建议：改完东西先跑一次不带 `--write` 的，看清楚它打算做什么再落盘。

---

## 已知限制

- **标签（tags）仍为空**。机械识别只能判断格式、尺寸、重复、分类，判断不了"这张图是什么表情"。要填 tags 需要人工标注，或接入视觉模型（需另行配置 API Key 和调用费用）。
- **GIF 只取首帧尺寸**，动图帧数不做解析。
- **HEIF / HEIC 无法自动转码**。Node 无内置解码器，这类文件会被标记告警，建议上传前自行转成 JPG/PNG。
- **分类名要能当目录名用**。不能含 `/ \ : * ? " < > |` 和控制字符，不能以 `.` 开头，长度 ≤ 40。中文分类名完全没问题。拼错的分类名会各自变成一个分类 —— 建议拼写前先看一眼已有的目录名。
- **平铺在 `Meme/images/` 根目录的图会被归入 `reactions`**。想自成一类，放进文件夹即可。
- **动态分类被清空后会从 JSON 里消失**（镜像语义）。预设的 `emotions` / `interactions` / `stickers` 会保留为空分类，作为固定槽位。
- **定时兜底是每小时一次**，不是实时。要立刻生效用 push 或手动触发。
- **仓库长期无活动时 GitHub 会自动停用定时任务**（官方策略：60 天无提交）。有正常提交就不会触发这条。

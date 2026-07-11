# cy-chat

字卡 & 表情包云端仓库。其他项目只需接入云端端点即可自动获取字卡和表情包数据。

## 仓库结构

```
cy-chat/
├── Word/
│   └── word.json      # 字卡数据端点
├── Meme/
│   ├── meme.json       # 表情包索引端点
│   └── images/         # 表情包图片资源
└── README.md
```

## 云端端点

| 端点 | 说明 |
|------|------|
| `Word/word.json` | 字卡数据（自定义回复、戳一戳、状态等） |
| `Meme/meme.json` | 表情包索引（分类、图片URL、标签） |

## 接入方式

其他项目通过获取对应的 JSON 文件即可使用：

```javascript
// 获取字卡
const res = await fetch('https://your-repo-url/Word/word.json');
const wordData = await res.json();

// 获取表情包
const memeRes = await fetch('https://your-repo-url/Meme/meme.json');
const memeData = await memeRes.json();
```

## 字卡数据格式 (word.json)

```json
{
  "name": "cy-chat Word Cards",
  "version": "1.0.0",
  "updatedAt": "2026-07-12T...",
  "categories": {
    "customReplies": {
      "label": "自定义回复",
      "items": [
        { "id": "reply_0001", "text": "你好", "tags": [] }
      ]
    }
  }
}
```

## 表情包数据格式 (meme.json)

```json
{
  "name": "cy-chat Meme Pack",
  "version": "1.0.0",
  "updatedAt": "2026-07-12T...",
  "categories": {
    "reactions": {
      "label": "反应表情",
      "items": [
        {
          "id": "meme_0001",
          "name": "点赞",
          "url": "Meme/images/reactions/thumbup.png",
          "tags": ["赞", "同意"]
        }
      ]
    }
  }
}
```

## 添加表情包

1. 将图片放入 `Meme/images/` 对应分类文件夹
2. 在 `meme.json` 对应分类的 `items` 数组中添加条目
3. 提交并推送到仓库

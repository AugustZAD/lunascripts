# LS JSON 输出参考手册

> 供前端播放器/游戏引擎对接使用。描述 `lsc compile` 输出的 JSON 结构、步骤类型、并发分组规则和引擎消费逻辑。

---

## 1. 顶层结构

```json
{
  "ls_contract_version": "2.0.0",
  "episode_id": "main:01",
  "branch_key": "main",
  "seq": 1,
  "title": "Butterfly",
  "steps": [ ... ],
  "gate": { ... } | null,
  "ending": { ... } | null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ls_contract_version` | string | 生成该 JSON 的 Lunaverse Script 契约版本；v2 固定为 `"2.0.0"` |
| `episode_id` | string | 集的完整标识，格式 `<branch_key>:<seq>`，如 `"main:01"` |
| `branch_key` | string | 分支路径，如 `"main"`、`"main/bad/001"`、`"remix/abc123"` |
| `seq` | number | 集序号（从 1 开始） |
| `title` | string | 集标题 |
| `steps` | array | 步骤数组（混合类型，见下文） |
| `gate` | object\|null | 路由规则（嵌套 if/else 链）。详见 §6 |
| `ending` | object\|null | 终结标记。详见 §7 |

### 1.1 gate / ending 的取舍

编译器根据 LS 源 `@gate { ... }` 块的内容决定填哪个字段：

- **纯无条件终结** `@gate { @end TYPE }` → `gate: null, ending: {type: TYPE}`
- **其他所有情形**——纯无条件 `@next`、条件路由、`@end`/`@next` 混合——→ `gate: <AST>, ending: null`

`ending` 字段为顶层简单形态，保留是为了与现有 overlay 系统平滑过渡。条件终结、`@end` 与 `@next` 混合的路由全部在 gate AST 内部表达（叶子节点可以是 `{next: ...}` 或 `{end: ...}`）。

成就是 inline step，不再出现在顶层字段——每个 `achievement` step 自带完整元数据，详见 §4.7。

---

## 2. Steps 数组：混合类型

`steps` 数组包含两种元素类型：

```
steps: [
  { ... },          // 对象 → 单步骤
  [ {...}, {...} ], // 数组 → 并发组
  { ... },          // 对象 → 单步骤
  ...
]
```

### 2.1 单步骤（对象）

一个普通的 JSON 对象，代表一条独立指令。引擎按顺序执行。

```json
{
  "type": "narrator",
  "text": "Senior year. Day one."
}
```

### 2.2 并发组（数组）

一个 JSON 数组，包含多个步骤对象。引擎**同时执行**组内所有步骤。

```json
[
  {
    "type": "bg",
    "name": "school_hallway",
    "url": "https://oss.mobai.com/.../school_hallway.png",
    "transition": "fade"
  },
  {
    "type": "music",
    "name": "tense_strings",
    "url": "https://oss.mobai.com/.../tense_strings.mp3"
  },
  {
    "type": "char_show",
    "character": "mauricio",
    "look": "neutral_smirk"
  }
]
```

### 2.3 分组规则

并发组由 LS 脚本中的 `@`（领导者）和 `&`（跟随者）前缀决定：

- `@` 指令开启新的步骤组
- `&` 指令加入前一个步骤组
- 对话行（dialogue / narrator / you）始终独立
- 只有一条指令的组自动展平为对象，不包裹数组

| LS 脚本 | JSON 输出 |
|----------|----------|
| `@bg set ...` 单独 | `{ "type": "bg", ... }` 对象 |
| `@bg set ...` + `&music ...` + `&<char> <pose>` | `[{"type":"bg"}, {"type":"music"}, {"type":"char_show"}]` 数组 |
| `NARRATOR: text` | `{ "type": "narrator", ... }` 对象（始终独立） |

---

## 3. 引擎消费规则

### 3.1 遍历算法

```
for element in steps:
    if element is array:
        // 并发组：同时执行所有步骤
        execute_all_simultaneously(element)
        if any_click_wait_type(element):
            wait_for_player_click()
    else:
        // 单步骤
        execute(element)
        if is_click_wait_type(element):
            wait_for_player_click()
```

### 3.2 点击等待类型

以下 type 需要等待玩家点击后才推进到下一个步骤：

| type | 说明 |
|------|------|
| `dialogue` | 角色对白 |
| `narrator` | 旁白 |
| `you` | 内心独白 |
| `pause` | 显式暂停 |

### 3.3 自动推进类型

以下 type 执行后立即推进，不等待玩家输入：

| type | 说明 |
|------|------|
| `bg` | 背景切换 |
| `char_show` | 角色显示 / 换 pose |
| `bubble` | 气泡动画 |
| `music` | 播放 BGM（引擎自动 from-silence/crossfade） |
| `music_stop` | 停止 BGM（淡出） |
| `sfx` | 一次性音效 |
| `affection` | 好感度变更 |
| `signal` | 持久信号写入（mark/int） |
| `achievement` | 成就解锁事件（自带元数据） |
| `butterfly` | 蝴蝶效应记录（喂下游生成 agent） |

### 3.4 交互阻塞类型

以下 type 会阻塞流程，由引擎内部管理推进：

| type | 说明 |
|------|------|
| `choice` | 选择菜单，等待玩家选择 |
| `minigame` | 可选小游戏，等待游戏结果（可跳） |
| `trick` | 强制 trick（引擎原生检测），不可跳 |
| `phone_show` | 手机界面（含 messages） |
| `cg_show` | CG 展示（视频管线） |
| `if` | 条件分支 |

### 3.5 角色可见性的隐式语义

JSON 不输出 `position` 字段——位置由引擎在运行时根据角色身份决定（MC 左、其余右）。引擎需维护角色可见性状态：

- **`char_show`** step：显示该角色（或切 pose，如果已显示）；隐式切换说明前一个角色被替换（同屏一人）
- **`dialogue`** step：引擎确保 `character` 字段对应的角色当前可见（用最后一次的 pose）；如果之前显示的是不同角色，自动切换
- **`narrator`** / **`you`** step：清屏——所有角色立绘移出

引擎自行管理"谁在场、用什么 pose"——编译器不输出隐式 hide 步骤，节奏由步骤序列驱动。

---

## 4. 步骤类型完整参考

### 4.0 Step ID（稳定步骤标识）

加在所有 step 上的 `id` 字段是后端 player cursor 的稳定锚点。这是**冻结契约**——一旦 episode JSON 发到带持久 session 的后端，编译器对 id 的算法就不能再变（除非配套数据迁移）。

#### 字段形态

每个 step 都有一个必填的 `id: string` 字段，格式 `<seq>_<tag>`，两段由下划线分隔。

```json
{
  "id": "0003_dlg",
  "type": "dialogue",
  "character": "easton",
  "text": "Can I sit?"
}
```

#### `<tag>` 段：类型缩写

`<tag>` 是 2-4 个小写字母，由 step 的 `type` 决定。一种 tag 可对应多个 step type（视觉/音频类按"组"归并）。

| step type | tag |
|-----------|-----|
| `dialogue` | `dlg` |
| `narrator` | `nar` |
| `you` | `you` |
| `pause` | `pau` |
| `choice` | `ch` |
| `minigame` | `mg` |
| `trick` | `trk` |
| `cg_show` | `cg` |
| `bg` | `bg` |
| `char_show` / `bubble` | `char` |
| `music` / `music_stop` | `mus` |
| `sfx` | `sfx` |
| `phone_show` / `text_message` | `phn` |
| `signal` | `sig` |
| `affection` | `aff` |
| `achievement` | `ach` |
| `butterfly` | `btf` |
| `if` | `ctrl` |

#### `<seq>` 段：4 位 0-padded 计数器，**Episode 全局作用域**

`<seq>` 是 4 位零填充的 1-based 整数。整个 episode 树共享一个单调递增计数器，按 DFS 前序遍历分配——**不在任何容器边界重置**。

子容器（`choice.options[i].steps`、`if.then`/`if.else`、`phone_show.messages`）的子步骤在父步骤被编号之后继续递增。`minigame`、`trick`、`cg_show` 都是 leaf step——它们各自消耗一个 seq，但**不开 child counter**，下一个兄弟步骤直接在父容器的计数器里继续。

**并发组**：LS 的 `&` 跟随节点会和 `@` 领导节点合并成一个 JSON 数组（见 §2.2），组内成员在同一个计数器里**继续递增**。

**嵌套 `@else @if`**：嵌套的 IfStep 本身不分配 id，只有其 `then`/`else` 子步骤使用共享计数器。

#### 例子

```
顶层 episode.steps:
  0001_dlg, 0002_nar, [0003_char, 0004_char], 0005_ch, 0014_dlg, 0015_dlg
                       ^^^^^^^^^^^^^^^^^^^^^^^^
                       并发组 — 计数器持续递增

steps[4] = 0005_ch choice 的 options[0].steps（Brave 选项 A）:
  0006_dlg, 0007_nar, 0008_dlg
  ^^^^^^^^
  从 choice 的 0005 之后继续递增
```

#### 唯一性

同一份 JSON 中**不会出现重复 id**——`sort(allStepIDs) == DFS 声明顺序`。后端 player cursor 既可以用 id 直接定位（全局唯一），也可以用完整路径定位。路径形式示例：

```
["0005_ch", "options", "A", "steps", "0006_dlg"]
```

#### 冻结契约

编译器内部的 `assignStepID` + `stepTypeTag` 函数（在 `internal/emitter/emitter.go`）是 step id 的**唯一权威**。一旦 episode JSON 已经发到带持久 player session 的后端：

- **不可改 tag**
- **不可改 seq 宽度**
- **不可改遍历顺序**
- **不可改起始值**

任何上述变更都会让所有持久化的 cursor 指错位置。如果实在要改，必须配套写一次性 cursor migration。

> **注意：** 本文剩余 §4.x 类型表中省略 `id` 字段以聚焦各类型自身字段。请把 `id: string` 当作所有 step 的隐式必填字段。

### 4.1 视觉类

#### `bg` — 背景切换

```json
{
  "type": "bg",
  "name": "school_hallway",
  "url": "https://oss.mobai.com/.../school_hallway.png",
  "transition": "fade"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 素材语义名 |
| `url` | string | 是 | 已解析的 OSS URL |
| `transition` | string | 否 | `"fade"` / `"cut"` / `"slow"`，不写为交叉溶解 |

#### `char_show` — 角色显示 / 换 pose

引擎使用同一 step type 处理"显示该角色"和"换 pose"两种情形——根据角色当前是否在场决定。**不输出 `position` 字段**——位置由引擎从角色身份派生（MC 左、其余右）。

```json
{
  "type": "char_show",
  "character": "mauricio",
  "look": "neutral_smirk",
  "url": "https://oss.mobai.com/.../mauricio_neutral_smirk.png",
  "transition": "dissolve"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `character` | string | 是 | 角色 ID（小写） |
| `look` | string | 是 | 立绘名 |
| `url` | string | 是 | 已解析的 OSS URL |
| `transition` | string | 否 | 过渡效果（如 `"dissolve"`、`"fade"`） |

引擎语义：
- 该角色当前不可见 → 显示该角色（带 transition）；同时隐式隐藏屏幕上的其他角色（同屏一人规则）
- 该角色当前已可见 → 切 pose（带 transition）

#### `bubble` — 气泡动画

```json
{
  "type": "bubble",
  "character": "josie",
  "bubble_type": "heart"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `character` | string | 是 | 角色 ID |
| `bubble_type` | string | 是 | `"anger"` / `"sweat"` / `"heart"` / `"question"` / `"exclaim"` / `"idea"` / `"music"` / `"doom"` / `"ellipsis"` |

#### `cg_show` — CG 展示（leaf）

CG 由 agent-forge 渲染为短视频。脚本只声明语义名 + 叙事 prose（`content` 字段），管线据此生成视频。运行时播放器只播放 `url`。

```json
{
  "type": "cg_show",
  "name": "window_stare",
  "url": "https://oss.mobai.com/.../window_stare.mp4",
  "content": "The camera opens on Malia's silhouette against the rain-streaked window. Slow push-in on her eyes — one tear tracks down, catching the cold blue of the skyline. Her reflection doubles her, ghost-like, in the glass."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | CG 素材语义名 |
| `url` | string | 是 | 已解析的 OSS URL（agent-forge 未跑完时可能为空字符串） |
| `content` | string | **是** | 英文连续叙述：镜头走向 + 故事情节。供 agent-forge 生成视频；运行时播放器可忽略 |

**leaf step**——无 `steps` 子数组、无 `duration`、无 `transition` 字段。CG 期间没有叠加对白；要在 CG 前后说话用普通 dialogue/narrator/you step。

### 4.2 对话类

#### `dialogue` — 角色对白

```json
{
  "type": "dialogue",
  "character": "mauricio",
  "text": "Hey, Butterfly."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `character` | string | 是 | 角色 ID（**始终小写**，脚本中 `MAURICIO:` → JSON 中 `"mauricio"`） |
| `text` | string | 是 | 对白内容 |

引擎语义：自动显示 `character` 角色（用最后一次的 pose，或默认 pose）；如果之前显示的是其他角色，自动切换。

> **注意：** 所有步骤类型中的 `character` 字段在 JSON 输出中统一为小写。

#### `narrator` — 旁白

```json
{
  "type": "narrator",
  "text": "Senior year. Day one."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 旁白内容 |

引擎语义：清屏（所有角色立绘消失）。

#### `you` — 内心独白

```json
{
  "type": "you",
  "text": "Another year. Same mess."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | MC 内心独白内容 |

引擎语义：清屏。视觉效果与 `narrator` 相同，区别在叙事口吻（第三人称 vs 第一人称）。

### 4.3 时序控制类

#### `pause` — 暂停等待

```json
{
  "type": "pause"
}
```

无字段。引擎等待玩家点击一次后推进。

### 4.4 手机/消息类

#### `phone_show` — 手机界面

```json
{
  "type": "phone_show",
  "messages": [
    {"type": "text_message", "direction": "from", "character": "easton", "text": "Can we talk?"},
    {"type": "text_message", "direction": "to", "character": "mauricio", "text": "How do you know?"}
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `messages` | array | 是 | 消息列表（`text_message` 对象，至少 1 条） |

引擎语义：弹出手机界面，依次展示 messages；玩家点击推进；最后一条消息后自动收起手机。**没有单独的 phone_hide step**——`phone_show` 的生命周期由其自身管理。

#### `text_message` — 短信消息（phone_show 内部）

```json
{
  "type": "text_message",
  "direction": "from",
  "character": "easton",
  "text": "Can we talk? I miss you."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `direction` | string | 是 | `"from"`（收到）/ `"to"`（发出） |
| `character` | string | 是 | 角色 ID |
| `text` | string | 是 | 消息内容 |

### 4.5 音频类

#### `music` — 播放 BGM

```json
{
  "type": "music",
  "name": "calm_morning",
  "url": "https://oss.mobai.com/.../calm_morning.mp3"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 曲目语义名 |
| `url` | string | 是 | 已解析的 OSS URL |

引擎语义：当前无 BGM → 淡入新 BGM；当前有 BGM → 交叉淡入。脚本不区分。

#### `music_stop` — 停止 BGM

```json
{
  "type": "music_stop"
}
```

无字段。引擎淡出当前 BGM。

#### `sfx` — 一次性音效

```json
{
  "type": "sfx",
  "name": "door_slam",
  "url": "https://oss.mobai.com/.../door_slam.mp3"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 音效语义名 |
| `url` | string | 是 | 已解析的 OSS URL |

### 4.6 游戏机制类

#### `choice` — 选择菜单

brave 和 safe 选项内容统一在 `steps` 字段下。brave 的成功/失败分支通过嵌套的 `@if (check.success) { } @else { }` step 表达（`check` condition type）。

```json
{
  "type": "choice",
  "options": [
    {
      "id": "A",
      "mode": "brave",
      "text": "Stand your ground.",
      "check": { "attr": "CHA", "dc": 12 },
      "steps": [
        {
          "type": "if",
          "condition": {"type": "check", "result": "success"},
          "then": [ ... ],
          "else": [ ... ]
        }
      ]
    },
    {
      "id": "B",
      "mode": "safe",
      "text": "Have Mark make a scene.",
      "steps": [ ... ]
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `options` | array | 是 | 选项列表 |

**Option 对象：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 选项编号（A / B / C ...） |
| `mode` | string | 是 | `"brave"`（需检定）/ `"safe"`（无检定） |
| `text` | string | 是 | 选项显示文本 |
| `check` | object | brave 必填 | `{ "attr": "CHA", "dc": 12 }` |
| `steps` | array | 是 | 选项体内所有步骤。brave 选项内部通常首个 step 就是一个 `check` 条件的 if——validator **不**强制 then/else 都填满 |

#### `minigame` — 可选小游戏（leaf）

`minigame` 是 leaf step——没有 body / steps / 评级分支。下游 vibe-coding agent 按 `description` 生成 H5 游戏，URL 写回素材表后由解析器填入 `game_url`。玩家可玩可跳；跳过等价于把整条 step 当 no-op，下一个 step 直接执行。奖励由引擎根据 H5 回传的分数缩放（反作弊在此），脚本不参与。

```json
{
  "type": "minigame",
  "name": "qte_challenge",
  "game_url": "https://oss.mobai.com/.../qte_challenge/index.html",
  "description": "Mr. Chen pairs Malia and Mauricio for the opening reading exercise..."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 素材句柄，用于查 `assets.minigames.<name>` |
| `game_url` | string | 否 | 已解析的小游戏 URL。生成器尚未完成时可缺省或为空字符串 |
| `description` | string | **是** | 连贯英文 prose：场景 + 简单玩法。喂给下游 vibe-coding agent；运行时播放器可忽略 |

#### `trick` — 强制 trick（leaf）

`trick` 是 leaf step。引擎检测玩家完成相应的体感动作之前**必须阻塞**——这是与 `minigame` 最根本的差别（minigame 可跳，trick 不能跳）。无奖励，无评级，无叙事分支。

```json
{
  "type": "trick",
  "trick_type": "hold",
  "prompt": "Hold your breath until he walks past."
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `trick_type` | string | 是 | 6 个锁定值之一：`tap` / `hold` / `swipe` / `shake` / `swing` / `tilt`。其它值是 parser/validator error |
| `prompt` | string | 是 | 一行祈使，给玩家看。不可为空串 |

阈值（点几下、按多久等）由引擎内置，**脚本不传**。所有 6 个类型都不需要摄像头 / 麦克风权限。

### 4.7 状态变更类

#### `affection` — 好感度

```json
{ "type": "affection", "character": "easton", "delta": 2 }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `character` | string | 是 | 角色 ID（小写） |
| `delta` | number | 是 | 增减值（可正可负） |

#### `signal` — 持久信号

```json
{ "type": "signal", "kind": "mark", "event": "EP01_COMPLETE" }
{ "type": "signal", "kind": "int", "name": "REJECTIONS", "op": "+", "value": 1 }
{ "type": "signal", "kind": "int", "name": "REJECTIONS", "op": "=", "value": 0 }
```

按 `kind` 分派字段：

**mark**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `kind` | string | 是 | `"mark"` |
| `event` | string | 是 | 事件名（SCREAMING_SNAKE_CASE 英文） |

**int**：

`name` 与 `mark.event` 使用同一作者命名规则：必须匹配
`^[A-Z][A-Z0-9_]*$`。小写裸名留给运行时声明的只读引擎数值。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `kind` | string | 是 | `"int"` |
| `name` | string | 是 | 作者变量名（`SCREAMING_SNAKE_CASE`，匹配 `^[A-Z][A-Z0-9_]*$`） |
| `op` | string | 是 | `"="` / `"+"` / `"-"` |
| `value` | number | 是 | 整数。op=`=` 时可为负；op=`+`/`-` 时为非负 |

引擎语义：
- `kind: "mark"` → 写入持久 flag store
- `kind: "int"` → 按 op 更新持久 int store；首次引用从 0 起算

#### `mark` 生命周期

1. 脚本发出 `@signal mark EVENT_NAME`
2. 引擎收到 `{"type": "signal", "kind": "mark", "event": "EVENT_NAME"}`，写入持久存储
3. 后续脚本中 `@if (EVENT_NAME) { }` 编译为 `{"type": "if", "condition": {"type": "flag", "name": "EVENT_NAME"}, ...}`
4. 引擎求值：在已存储的 marks 中查找 → 找到返回 true，否则返回 false

#### `achievement` — 成就解锁

```json
{
  "type": "achievement",
  "achievement_id": "HIGH_HEEL_DOUBLE_KILL",
  "name": "Heel Twice Over",
  "rarity": "epic",
  "description": "Once is improvisation. Twice is a signature move."
}
```

引擎收到该 step 后走成就系统：UI 弹窗、解锁状态持久化、数据上报。同一 `achievement_id` 重复触发由引擎按 `achievement_id` 去重（首次解锁即生效）。触发事件**不**影响 flag 存储。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `achievement_id` | string | 是 | 成就语义标识（来自 LS `@achievement <id>`） |
| `name` | string | 是 | 显示名称（英文） |
| `rarity` | string | 是 | `"uncommon"` / `"rare"` / `"epic"` / `"legendary"`（**无 `common`**） |
| `description` | string | 是 | DM 口吻 flavor 文本（英文） |

> **注意 `id` vs `achievement_id`：** 与所有 step 一样，`achievement` 也带通用的 `id` 字段（cursor 稳定步骤 id，格式 `<seq>_ach`，见 §4.0）；`achievement_id` 才是 LS 源里 `@achievement <id>` 写下的语义标识。两者不可互换：执行器/UI 用 `achievement_id` 记录解锁状态，cursor 用 `id` 定位。`minigame` step 同理用 `name` 携带素材句柄，通用的 `id` 字段是 cursor 锚点。

#### `butterfly` — 蝴蝶效应记录

```json
{ "type": "butterfly", "description": "Accepted Easton's approach at the cafeteria" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 是 | 英文 prose：玩家行为与其性格含义 |

**消费者**：Remix Executor 和 Dream 内容生成器。引擎收到 step 后追加到玩家的 butterfly 累积存储，提供给下游生成 agent 作为玩家画像数据。**不参与运行时路由判定**——gate 求值不读 butterfly 累积。

### 4.8 流程控制类

#### `if` — 条件分支

条件为**完全结构化的 AST 对象**（不含表达式字符串），后端可直接遍历判定。`else` 可以是步骤数组（简单 else）或嵌套的 `if` 对象（`@else @if` 链）。

```json
{
  "type": "if",
  "condition": {
    "type": "compound",
    "op": "&&",
    "left":  {"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">=", "right": {"kind": "literal", "value": 5}},
    "right": {"type": "comparison", "left": {"kind": "value", "name": "CHA"}, "op": ">=", "right": {"kind": "literal", "value": 14}}
  },
  "then": [ ... ],
  "else": {
    "type": "if",
    "condition": {"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">=", "right": {"kind": "literal", "value": 3}},
    "then": [ ... ],
    "else": [ ... ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `condition` | object | 是 | 结构化条件 AST（见条件类型参考） |
| `then` | array | 是 | 条件成立时执行的步骤 |
| `else` | array\|object | 否 | 步骤数组（简单 `@else { }` → `[...]`）或裸 `if` 对象（`@else @if` 链 → `{"type": "if", ...}`） |

#### 条件类型参考

条件对象包含 `type` 字段和类型特有字段。**所有条件字段都是结构化的，不含表达式字符串**。

**`choice`** — 选项检定结果

```json
{"type": "choice", "option": "A", "result": "fail"}
```

| 字段 | 取值 |
|------|------|
| `option` | 选项 ID（`"A"` / `"B"` / ...） |
| `result` | `"success"` / `"fail"` / `"any"` |

**`flag`** — 信号布尔标记

```json
{"type": "flag", "name": "EP01_COMPLETE"}
```

**`comparison`** — 数值比较。左右两侧都是 operand AST：

```json
// 变量与字面量
{"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">=", "right": {"kind": "literal", "value": 5}}

// 变量与变量
{"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">", "right": {"kind": "affection", "char": "diego"}}

// 引擎/作者变量
{"type": "comparison", "left": {"kind": "value", "name": "san"}, "op": "<=", "right": {"kind": "literal", "value": 20}}

// 聚合 operand
{"type": "comparison", "left": {"kind": "max", "args": [
  {"kind": "affection", "char": "easton"},
  {"kind": "affection", "char": "diego"}
]}, "op": ">=", "right": {"kind": "literal", "value": 5}}
```

| 字段 | 说明 |
|------|------|
| `left` | Operand AST（见 operand 类型） |
| `op` | `">="` / `"<="` / `">"` / `"<"` / `"=="` / `"!="` |
| `right` | Operand AST（见 operand 类型） |

#### Operand 类型

`comparison.left` 和 `comparison.right` 都是 operand AST，包含 `kind` 字段。**5 种 kind**：`literal` / `affection` / `value` / `max` / `min`。

**`literal`** — 整数字面量

```json
{"kind": "literal", "value": 5}
{"kind": "literal", "value": -2}
```

**`affection`** — 角色好感度

```json
{"kind": "affection", "char": "easton"}
```

| 字段 | 说明 |
|------|------|
| `char` | 角色 ID（小写） |

**`value`** — 裸名数值（引擎管理数值或作者 `@signal int` 变量）

```json
{"kind": "value", "name": "san"}
{"kind": "value", "name": "REJECTIONS"}
```

| 字段 | 说明 |
|------|------|
| `name` | 数值名。引擎在自己的数值存储和 signal int 存储中按裸名查找（共享命名空间） |

**`max` / `min`** — 聚合 operand

求 args 列表中所有 operand 的最大值（`max`）或最小值（`min`）。args 数量**任意 ≥ 2**，没有上限——可以聚合两个、三个、四个甚至更多 operand。

```json
// 2 args
{
  "kind": "max",
  "args": [
    {"kind": "affection", "char": "easton"},
    {"kind": "affection", "char": "diego"}
  ]
}

// 4 args（4 个 LI 的最高好感度）
{
  "kind": "max",
  "args": [
    {"kind": "affection", "char": "easton"},
    {"kind": "affection", "char": "diego"},
    {"kind": "affection", "char": "mauricio"},
    {"kind": "affection", "char": "elias"}
  ]
}

// 混合 operand kind
{
  "kind": "min",
  "args": [
    {"kind": "affection", "char": "easton"},
    {"kind": "value", "name": "REJECTIONS"},
    {"kind": "literal", "value": 10}
  ]
}

// 递归嵌套（不鼓励但合法）
{
  "kind": "max",
  "args": [
    {"kind": "affection", "char": "easton"},
    {"kind": "min", "args": [
      {"kind": "affection", "char": "diego"},
      {"kind": "affection", "char": "mauricio"}
    ]}
  ]
}
```

| 字段 | 说明 |
|------|------|
| `args` | Operand AST 数组。**长度 ≥ 2，无上限**。每个 arg 可以是任意 kind（含递归嵌套的 max/min） |

引擎语义：递归求值每个 arg，然后取这些值的最大/最小值。

**`compound`** — 复合条件。`left` 和 `right` 是递归的完整条件对象：

```json
{
  "type": "compound",
  "op": "&&",
  "left":  {"type": "flag", "name": "A"},
  "right": {"type": "comparison", "left": {"kind": "value", "name": "san"}, "op": "<=", "right": {"kind": "literal", "value": 20}}
}
```

| 字段 | 说明 |
|------|------|
| `op` | `"&&"` 或 `"\|\|"` |
| `left` | 左子条件（任意条件类型对象，支持递归嵌套） |
| `right` | 右子条件（任意条件类型对象，支持递归嵌套） |

**`check`** — brave option 检定结果条件（context-local）

```json
{"type": "check", "result": "success"}
```

| 字段 | 取值 |
|------|------|
| `result` | `"success"` / `"fail"` |

只在 brave option 体内的 `@if` 里生成。编译器不做作用域校验；源脚本写在错误位置时运行时恒为 false。

---

## 5. 并发组行为

### 5.1 执行模型

```
并发组 = [step_1, step_2, step_3]

引擎行为：
  1. 同时发起 step_1, step_2, step_3 的执行
  2. 检查组内是否包含点击等待类型（dialogue / narrator / you / pause）
     - 有 → 渲染完成后等待玩家点击
     - 无 → 立即推进到下一个步骤/组
```

### 5.2 典型并发组场景

**场景搭建**（最常见用法）：

LS 源码：
```
@bg set school_cafeteria fade
&music casual_lunch
&mark grin_confident
```

JSON 输出：
```json
[
  {"type": "bg", "name": "school_cafeteria", "url": "...", "transition": "fade"},
  {"type": "music", "name": "casual_lunch", "url": "..."},
  {"type": "char_show", "character": "mark", "look": "grin_confident", "url": "..."}
]
```

引擎行为：同时切背景 + 换音乐 + 角色入场。全部是自动推进类型，无需等待。

**角色 + 气泡同步**：

```json
[
  {"type": "char_show", "character": "mauricio", "look": "arms_crossed_angry", "url": "..."},
  {"type": "bubble", "character": "josie", "bubble_type": "sweat"}
]
```

注意"同屏一人"规则——只有最后一个 `char_show` 实际显示。气泡和角色不同类，可以共存（气泡跟着当前在场的角色）。

---

## 6. Gate 路由

`gate` 是集末尾的路由声明，决定玩家完成本集后跳转到哪一集或如何终结。采用嵌套 if/else 链结构，条件为结构化对象，**叶子节点可以是 `{next: <branch_key>}` 或 `{end: <ending_type>}`**。

### 6.1 形态示例

**纯条件路由**：

```json
"gate": {
  "if": {"type": "choice", "option": "A", "result": "fail"},
  "next": "main/bad/001:01",
  "else": {
    "if": {"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">=", "right": {"kind": "literal", "value": 5}},
    "next": "main/route/001:01",
    "else": {"next": "main:02"}
  }
}
```

**条件终结 + 路由混合**：

```json
"gate": {
  "if": {"type": "comparison", "left": {"kind": "value", "name": "REJECTIONS"}, "op": ">=", "right": {"kind": "literal", "value": 3}},
  "end": "bad_ending",
  "else": {
    "if": {"type": "flag", "name": "HEROIC_END"},
    "end": "complete",
    "else": {"next": "main:02"}
  }
}
```

**无条件路由**：

```json
"gate": {"next": "main:02"}
```

### 6.2 判定规则

- 引擎按 if → else.if → else 链式判定
- 第一个命中的条件生效，使用对应的叶子动作
- 叶子动作有两种：`next` → 跳转到 branch_key；`end` → 显示终结画面（type 为 `complete` / `to_be_continued` / `bad_ending`）
- 最内层的 `else` 节点只有叶子动作字段（`next` 或 `end`），不再嵌套

### 6.3 Gate 节点结构

每个 gate 节点包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `if` | object | 否 | 结构化条件对象（最内层 else 兜底节点无此字段） |
| `next` | string | next 叶子必填 | 命中时跳转的目标 episode_id |
| `end` | string | end 叶子必填 | 命中时终结的类型（`complete` / `to_be_continued` / `bad_ending`）。与 `next` 互斥 |
| `else` | object | 否 | 下一个 gate 节点（嵌套 if/else） |

### 6.4 条件类型

Gate 中的条件使用与 body `@if` 相同的结构化 AST 格式（见 §4.8 条件类型参考），所有 4 种类型可用：`choice` / `flag` / `comparison` / `compound`。

**gate 中不会出现 `check` 条件**——它只在 brave option 体内的 body `@if` 里生成。

---

## 7. Ending 终结标记

`ending` 字段是简单形态的集终结声明——仅在 LS 源使用纯无条件 `@gate { @end TYPE }` 时由编译器填入：

```json
{
  "gate": null,
  "ending": {"type": "bad_ending"}
}
```

| type | 含义 | 引擎行为建议 |
|------|------|-------------|
| `complete` | 全剧终 | 滚字幕/致谢画面，可回到主菜单 |
| `to_be_continued` | 待续 | "本章完，敬请期待" 画面 |
| `bad_ending` | 坏结局 | 显示坏结局提示，提供重开本章入口 |

**消费规则：**

- 若 `ending != null`：播放完 `steps` 后进入终结画面，不再消费 `gate`
- 若 `gate != null`：播放完 `steps` 后走 gate 判定。判定到 `next` 叶子 → 跳转；判定到 `end` 叶子 → 显示对应终结画面
- 两者均为 null 在编译时已拒绝，前端不会遇到

---

## 8. 完整 JSON 示例

以下示例展示了并发组、单步骤、暂停、选择、条件分支和路由的完整 JSON 输出：

```json
{
  "episode_id": "main:01",
  "branch_key": "main",
  "seq": 1,
  "title": "Butterfly",
  "steps": [
    [
      {
        "type": "bg",
        "name": "malias_bedroom_morning",
        "url": "https://oss.mobai.com/novel_001/bg/malias_bedroom_morning.png"
      },
      {
        "type": "music",
        "name": "calm_morning",
        "url": "https://oss.mobai.com/novel_001/music/calm_morning.mp3"
      },
      {
        "type": "char_show",
        "character": "malia",
        "look": "neutral_phone",
        "url": "https://oss.mobai.com/novel_001/characters/malia_neutral_phone.png"
      }
    ],
    {
      "type": "narrator",
      "text": "Senior year. Day one. Status: already complicated."
    },
    {
      "type": "you",
      "text": "Another year. Same mess."
    },
    {
      "type": "phone_show",
      "messages": [
        {"type": "text_message", "direction": "from", "character": "easton", "text": "Can we talk? I miss you."},
        {"type": "text_message", "direction": "from", "character": "easton", "text": "I know I messed up."}
      ]
    },
    {
      "type": "you",
      "text": "Eight months and he still won't stop."
    },
    {
      "type": "char_show",
      "character": "malia",
      "look": "worried",
      "url": "https://oss.mobai.com/novel_001/characters/malia_worried.png"
    },
    {
      "type": "pause"
    },
    {
      "type": "choice",
      "options": [
        {
          "id": "A",
          "mode": "brave",
          "text": "Let him come.",
          "check": {
            "attr": "CHA",
            "dc": 12
          },
          "steps": [
            {
              "type": "if",
              "condition": {"type": "check", "result": "success"},
              "then": [
                {"type": "signal", "kind": "mark", "event": "EASTON_APPROACHED_EP01"},
                {
                  "type": "char_show",
                  "character": "easton",
                  "look": "relieved",
                  "url": "https://oss.mobai.com/novel_001/characters/easton_relieved.png"
                },
                {"type": "dialogue", "character": "easton", "text": "Can I sit?"},
                {"type": "dialogue", "character": "malia", "text": "You have two minutes."},
                {"type": "affection", "character": "easton", "delta": 2},
                {"type": "signal", "kind": "int", "name": "EASTON_APPROACHES_ACCEPTED", "op": "+", "value": 1},
                {"type": "butterfly", "description": "Accepted Easton's approach at the cafeteria"}
              ],
              "else": [
                {
                  "type": "char_show",
                  "character": "easton",
                  "look": "hurt",
                  "url": "https://oss.mobai.com/novel_001/characters/easton_hurt.png"
                },
                {"type": "dialogue", "character": "malia", "text": "I... I can't do this."},
                {"type": "butterfly", "description": "Tried to face Easton but lost courage"}
              ]
            }
          ]
        },
        {
          "id": "B",
          "mode": "safe",
          "text": "Have Mark make a scene.",
          "steps": [
            {
              "type": "char_show",
              "character": "mark",
              "look": "grin_mischief",
              "url": "https://oss.mobai.com/novel_001/characters/mark_grin_mischief.png"
            },
            {"type": "dialogue", "character": "mark", "text": "HEY EASTON! You want some of my mystery casserole?"},
            {"type": "bubble", "character": "mark", "bubble_type": "music"},
            {"type": "you", "text": "Thank god for Mark."},
            {"type": "butterfly", "description": "Had Mark create a diversion to avoid Easton"}
          ]
        }
      ]
    },
    {
      "type": "if",
      "condition": {
        "type": "compound",
        "op": "&&",
        "left":  {"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">=", "right": {"kind": "literal", "value": 5}},
        "right": {"type": "comparison", "left": {"kind": "value", "name": "CHA"}, "op": ">=", "right": {"kind": "literal", "value": 14}}
      },
      "then": [
        {"type": "dialogue", "character": "easton", "text": "You remembered."}
      ],
      "else": [
        {"type": "dialogue", "character": "easton", "text": "...Hey."}
      ]
    },
    {"type": "signal", "kind": "mark", "event": "EP01_COMPLETE"}
  ],
  "gate": {
    "if": {"type": "choice", "option": "A", "result": "fail"},
    "next": "main/bad/001:01",
    "else": {
      "if": {"type": "comparison", "left": {"kind": "affection", "char": "easton"}, "op": ">=", "right": {"kind": "literal", "value": 3}},
      "next": "main/route/001:01",
      "else": {"next": "main:02"}
    }
  },
  "ending": null
}
```

### 8.1 终结集示例（纯无条件）

```json
{
  "episode_id": "main/bad/001:02",
  "branch_key": "main/bad/001",
  "seq": 2,
  "title": "Bad End",
  "steps": [
    {"type": "bg", "name": "malias_bedroom_night", "url": "..."},
    {"type": "narrator", "text": "She never came home."}
  ],
  "gate": null,
  "ending": {"type": "bad_ending"}
}
```

### 8.2 条件终结示例（gate 内含 end 叶子）

```json
{
  "episode_id": "main/route/redemption:03",
  "branch_key": "main/route/redemption",
  "seq": 3,
  "title": "The Final Choice",
  "steps": [ ... ],
  "gate": {
    "if": {"type": "flag", "name": "ALL_LIS_REJECTED"},
    "end": "bad_ending",
    "else": {
      "if": {"type": "comparison", "left": {"kind": "max", "args": [
        {"kind": "affection", "char": "easton"},
        {"kind": "affection", "char": "mauricio"},
        {"kind": "affection", "char": "elias"}
      ]}, "op": ">=", "right": {"kind": "literal", "value": 8}},
      "end": "complete",
      "else": {"next": "main/route/redemption:04"}
    }
  },
  "ending": null
}
```

---

## 9. 稀有度目标分布

设计剧情成就时的典型解锁率目标（参考值，非强制）：

| rarity | 典型解锁率 | 典型触发形态 |
|--------|-----------|-------------|
| `uncommon` | 20-40% | 单集戏剧性选择的其中一支 |
| `rare` | 5-20% | 反直觉选择、DC 14+ 检定、两集组合、失败路径 |
| `epic` | 1-5% | 3+ 集的行为模式 |
| `legendary` | <1% | 4+ 集的组合 + 特定检定结果 |

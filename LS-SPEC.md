# Lunascripts (LS) 格式设计规范

> 定义 MobAI 互动视觉小说的完整脚本标记语法、文件结构、解释器职责。

---

## 1. 设计目标

1. **单一格式统一叙事与游戏机制**：一个 `.ls` 文件既是剧情脚本也是数值定义
2. **自包含**：每个文件包含一集所需的全部信息，不依赖外部清单
3. **LLM 友好**：Lunaverse Agent 生成和编辑此格式，语法对 LLM 自然、无认知负担
4. **高效解析**：Go 单二进制解释器消费，输出结构化 JSON 供前端播放器使用
5. **素材解耦**：脚本只写语义名，解释器通过独立的素材映射表翻译为 OSS URL

---

## 2. 文件结构

### 2.1 文件粒度

一个 `.ls` 文件 = 一集。Lunaverse Agent 按集创建和编辑，局部改写后仍保存为完整合法的 `.ls` 集文件。

### 2.2 文件后缀

使用 `.ls` 后缀。文件是 UTF-8 纯文本，可由 Lunaverse IDE 或普通文本编辑器打开。

### 2.3 文件命名

对齐 `episode_id` 寻址体系，路径即 ID：

```
novel_<id>/
├── main/
│   ├── 01.ls                      # main:01
│   ├── 02.ls                      # main:02
│   ├── ...
│   ├── bad/
│   │   ├── 001/
│   │   │   ├── 01.ls              # main/bad/001:01
│   │   │   └── 02.ls              # main/bad/001:02
│   │   └── 002/
│   │       └── 01.ls              # main/bad/002:01
│   ├── route/
│   │   └── 001/
│   │       ├── 01.ls              # main/route/001:01
│   │       └── 02.ls              # main/route/001:02
│   └── minor/
│       └── 11_a/
│           └── 01.ls              # main/minor/11_a:01
└── remix/
    └── <session_id>/
        ├── 01.ls                  # remix/<session_id>:01
        └── 02.ls                  # remix/<session_id>:02
```

**规则**：
- 目录结构即 `branch_key`，文件名（不含扩展名）即 `seq`
- 解释器从路径推导 `episode_id`（如 `main/bad/001/02.ls` → `main/bad/001:02`）
- Remix 输出放在 `remix/<session_id>/` 下，格式与主线完全一致

### 2.4 文件编码

UTF-8，换行符 `\n`。

---

## 3. 语法总览

### 3.1 基本规则

```
// 这是注释，行首 // 标记
// 空行被忽略

@episode main:01 "Butterfly" {
  // 所有内容在 @episode 块内
  // 指令以 @ 开头
  // 对话以 角色名: 开头（全大写）
  // 块用 { } 界定，支持嵌套
}
```

- **注释**：`//` 行首标记，整行忽略
- **空行**：忽略，用于可读性分段
- **字符串**：用双引号 `"..."` 包裹
- **块**：`{ }` 界定，可嵌套
- **指令**：`@` 前缀
- **并发指令**：`&` 前缀，与前一条 `@` 指令同时执行（详见 4.9 并发控制）
- **对话**：`角色名: 文本`，角色名全大写，无 `@` 前缀

### 3.2 指令分类

| 类别 | 职责 |
|------|------|
| 结构控制 | 集定义、路由 |
| 视觉呈现 | 背景、角色、CG、气泡 |
| 对话 | 角色对白、旁白、内心独白 |
| 手机/消息 | 短信界面 |
| 音频 | BGM、音效 |
| 交互原语 | trick（强制体感）、minigame（可选小游戏）、choice（强制选择 + D20）、CG（叙事过场） |
| 状态变更 | 好感度、信号、蝴蝶效应、成就 |
| 流程控制 | 条件分支 |
| 时序控制 | 暂停等待、并发执行 |

### 3.3 角色与位置

- **MC**（玩家扮演的角色）固定在屏幕**左侧**
- **其余角色**全部固定在屏幕**右侧**
- **同屏一人**——任意时刻最多一个角色显示
- 谁有台词谁显示（YOU 行显示 MC），前一个自动消失；没有台词支撑的立绘指令会被吞掉
- `NARRATOR` 出现时清空所有立绘（无角色立绘）；`YOU` 和角色台词出现时有立绘

引擎在运行时知道谁是 MC（从 gamestate 注入），编译产物**不携带 MC 身份信息**——LS 对小说哪个角色是 MC 完全 agnostic，由前端业务层注入。

---

## 4. 指令完整定义

### 4.1 结构控制

#### `@episode <branch_key> "<title>" { }`

集定义，整个文件的根块。

```
@episode main:01 "Butterfly" {
  // 全部内容
}
```

`branch_key` 同时也从文件路径派生（见 §2.3），写在 header 里冗余但作为路径不一致的 sanity check 保留。

#### `@gate { }`

路由声明块，**必须位于 `@episode` 块的尾部，每集恰好一个**。声明本集的所有出口——是路由到下一集 (`@next`)，还是终结剧情 (`@end`)。

```
@gate {
  @if (A.fail): @next main/bad/001:01
  @else @if (HEROIC_END_REACHED): @end complete
  @else: @next main:02
}
```

**两种节点形态**：

- **`@next <branch_key>`** — 路由到指定 episode
- **`@end <type>`** — 终结剧情，`type ∈ complete | to_be_continued | bad_ending`

| ending type | 含义 | 典型用法 |
|------|------|---------|
| `complete` | 全剧终 | 主线大结局、所有角色 Happy End |
| `to_be_continued` | 待续 | 本季/本章已完，下一章尚未写好 |
| `bad_ending` | 坏结局 | 坏路线终点、NPC 阵亡、玩家出局 |

**最简形态**——纯终结集或纯无条件路由：

```
@gate { @end bad_ending }
@gate { @next main:02 }
```

**条件混合**——`@next` 与 `@end` 可共存于同一个 gate 的不同分支：

```
@gate {
  @if (REJECTIONS >= 3): @end bad_ending
  @else @if (HEROIC_END): @end complete
  @else: @next main:02
}
```

**约束**：
- 每集恰好一个 `@gate` 块
- gate 必须有完整覆盖：要么是单个无条件 `@next`/`@end`，要么是包含 `@else` 的完整 `@if/@else` 链
- 缺少 `@gate` → validator 报 `MISSING_TERMINAL` 错误

#### `@if (<condition>): @next <branch_key>` / `@if (<condition>): @end <type>`

gate 块内的条件出口规则。括号 `()` 必需。条件类型见 §4.8。

#### `@else @if (<condition>): ...`

链式条件，前一个 `@if` 不命中时继续判定。可连续使用多个 `@else @if`。

#### `@else: <next 或 end>`

兜底分支。所有 `@if` 都不命中时走这里。

#### `@pause`

暂停指令，等待玩家点击一次后继续。用于"无文字停顿"，制造节奏停顿。

```
@pause
```

需要更长停顿请用连续 `@pause` 或拆成多个旁白行。

---

### 4.2 视觉呈现

所有视觉指令遵循 **对象-行动** 模式。

#### 角色指令

**`@<char> <pose> [transition]`** — 显示角色 / 切换 pose

```
@malia worried
@malia worried dissolve
@mauricio neutral_smirk fade
```

- `char`：角色 ID（小写）
- `pose`：源语法中对角色立绘素材键的历史名称；进入 AST 和 Episode JSON 后字段名为 `look`
- `transition`：可选过渡。不写 = 瞬切。常用值：`dissolve`（0.3s 交叉溶解）、`fade`（淡入）

The source `pose` operand becomes `look` in the AST and is emitted unchanged as
the Episode JSON asset key. The parser, compiler, validator, and runtime treat
that key as opaque for backward compatibility. They MUST continue accepting
and emitting every legacy key unchanged, including a bare key such as `smile`,
an existing four-field stateful key, malformed delimiters or empty fields, and
an exactly three-field canonical-looking key whose leading owner differs from
the staged character. The compiler cannot distinguish an old stored key from a
new authoring mistake and therefore does not enforce owner equality.

For **new production content**, the standard asset identity is
`<char>__<outfit>__<demeanor>[-<action>]`. Producer tooling such as Episode
Writer and IDE lint MUST require the leading `<char>` to equal the staged
character identifier and may reject malformed or non-canonical keys before new
content is accepted. The compiler does not own the demeanor/action vocabulary;
producer tooling validates that external asset contract. This two-layer rule
applies equally to `@<char> <pose>` and dialogue sugar `CHAR [<pose>]:`.

**首次出现的角色**自动入场，后续相同角色再次出现则切 pose。**位置固定**（MC 左、其余右），不可指定。

引擎记忆每个角色最后一次的 pose——再次说话时默认沿用，作者用糖 `CHAR [pose]: text` 显式覆盖。

**`@<char> bubble <type>`** — 气泡动画

```
@josie bubble heart
@mauricio bubble anger
```

一次性播放后自动消失，气泡跟随当前角色。角色被切走时气泡随之消失。**`<type>` 必填**，不可省略。

| type | 视觉效果 |
|------|---------|
| `anger` | 💢 怒气 |
| `sweat` | 💧 冷汗 |
| `heart` | ❤️ 心动 |
| `question` | ❓ 疑惑 |
| `exclaim` | ❗ 惊讶 |
| `idea` | 💡 灵机一动 |
| `music` | 🎵 开心/哼歌 |
| `doom` | 💀 绝望 |
| `ellipsis` | ... 沉默/无语 |

**保留字**：`bubble` 是保留字——pose 名不可与之冲突。素材表中不允许 pose 命名为 `bubble`。

#### 背景指令

**`@bg set <name> [transition]`** — 切换背景

| transition | 效果 | 耗时 | 适用场景 |
|-----------|------|------|---------|
| （不写） | 交叉溶解 | 0.5s | 同场所内时间变化 |
| `fade` | 先黑屏再淡入 | 1.0s | 场景切换 |
| `cut` | 直切 | 0s | 快速跳转 |
| `slow` | 慢速淡入 | 2.0s | 情绪性转场 |

#### CG 指令

**`@cg <name> "<content>"`** — 全屏 CG 展示（leaf 指令）

CG 的最终交付可以是静态图、视频或动态漫画。脚本只声明 CG 的语义名和形态中立的叙事 prose；具体形态由生产阶段选择。

- `<name>`：素材句柄。生成完后 URL 填进 `assets.cg.<name>`
- `<content>`：**英文**现在时场景描写（与 SKILL.md"语言:全英文"硬性规则一致；仅当用户明确要求中文写剧本时才用中文）。**不要辞藻**（不写 "poetically" / "hauntingly beautiful" 这类修饰），只讲清楚人物、场景、动作和剧情关联，不在 LS 中锁死时长或输出形态。

**写法要求——可生产的事件描述**：

不要只写抽象情绪或通用意境。按事件发生顺序写清可见的人物动作、神态、站位和关键道具，使静态图、视频或动态漫画都能从同一段剧情描述继续生产：

```
❌ 概括式
@cg dinner_first_night "A dim kitchen at night. Three men sit in their usual places while a girl stands in the doorway with her suitcase."

✅ 分镜式
@cg dinner_first_night "@seren drags her suitcase into @bg voss_house_kitchen_evening. A single dim bulb. An old wooden table — three mismatched place settings. A fourth chair pushed back against the wall. @knox stands at the stove, back to the room, plate in hand, eyes pinned on his bowl. @liam leans back in his chair, cap on backwards, fingers tapping the table edge, half a smile. @dean sits at the head of the table, sharp blue eyes cutting to the doorway. The suitcase drags a gray scar across the floor. Four people, four corners."
```

**`@角色名` 和 `@bg` 标签嵌在描述里**：在角色出场的那句镜头里自然写入 `@角色名`，在场景建立镜头里写入 `@bg <bg_name>`。不要把标签堆在开头当前缀。角色在 CG 内从一个场景移动到另一个场景时，按出现顺序写多个 `@bg`（例：`@seren backs out of @bg voss_house_dean_study, down the length of @bg voss_house_hallway_evening...`）。`@bg` 名必须来自资产表，不要自造。

**视频形态的 CG（plan 标注或在 IDE 里切为视频）**：生产前必须把形态中立描述精修为 `08-cg-production/prompts/video/<safe-cg-name>.md`。该文件只放视频专属描述，不放风格头、模型、时长、比例、分辨率、引用 URL/列表或 videoctl YAML；宿主随后只拼一次当前风格的 `cg-video` 模板。文件缺失或相对原始描述已过期时，必须先补写并保存，禁止发起付费视频生成。

视频专属描述围绕**一个主要机位**组织动作并明确镜头行为：固定机位写清 `no dolly, no zoom, no pan`；运动机位最多一个主要运动。用可见的身体反应代替抽象情绪；POV 必须无歧义；剧情关键道具单独成句；避免可读文字和淡出全黑；已有精确服装参考图时不要重复服装。不要增加时长限制。声音合同固定为**无配乐，仅保留同期声**：允许环境声、动作声和现场同期声，禁止 BGM。

**语法约束**：
- 叶子指令，无 `{ }` body
- 与 `@minigame` **语法形态**对称（`@<原语> <name> "<prose>"` → 下游 agent 生成）；内容写法不同——minigame 是英文单句，CG 是多句分镜

---

### 4.3 对话

对话指令不用 `@` 前缀，通过行首角色名（全大写）识别。

```
MAURICIO: That's not a library. That's a crime scene.
NARRATOR: Senior year. Day one.
YOU: He hasn't called me that in eight years.
```

- **`CHARACTER:`** — 角色对白。说话时角色自动显示（用上次 pose 或当前 pose）；与上一个说话者不同时自动切换
- **`NARRATOR:`** — 旁白，MC 视角但有叙事距离。指代 MC 用**大写 YOU / YOUR / YOURS**，不用 she / her / hers 或 她（详见 SKILL.md）。出现时**清屏**（所有角色立绘消失）
- **`YOU:`** — MC 内心独白，第一人称（我）。**显示 MC 立绘**（`YOU:` 前声明 `@<mc_char> <look>`）

`NARRATOR` 和 `YOU` 视觉效果**不同**：`NARRATOR` 清屏（无立绘），`YOU` 显示 MC 立绘。区别在叙事口吻：`NARRATOR` 是 MC 视角、有距离感的观察与描述（指代 MC 用大写 YOU），`YOU` 是 MC 此刻的内心思考（第一人称 我）。因此立绘指令应放在 `YOU` 或角色台词行之前，不要放在 `NARRATOR` 行之前（会被清掉、白写）。

**语法糖：pose 变换 + 对白一行完成**

```
CHARACTER [pose]: text
```

等价于：

```
@character pose
CHARACTER: text
```

`CHARACTER [pose]:` 中的 `pose` 会以 AST/JSON 的 `look` 字段原样输出，
因此同样遵守上述两层规则：编译链兼容所有存量 opaque 键（包括三段错
owner 和畸形键）；Episode Writer / IDE 等 producer 则对新写内容严格要求
`<char>__<outfit>__<demeanor>[-<action>]` 且 owner 与说话角色一致。

例：

```
MAURICIO [arms_crossed_angry]: Your call, Butterfly.
```

---

### 4.4 手机/消息

```
@phone {
  @text from EASTON: Can we talk? I miss you.
  @text from EASTON: I know I messed up.
  @text to MAURICIO: How do you know where I live?
}
```

- `@phone { ... }`：弹出手机界面；块结束自动收起
- `@text from <char>: content`：收到的消息（灰色气泡，左对齐）
- `@text to <char>: content`：发出的消息（蓝色气泡，右对齐）

**块内只允许 `@text from/to`**——旁白、音效、状态变更必须放在 `@phone` 块外。

---

### 4.5 音频

```
@music calm_morning             // 播放 BGM（引擎自动判断 from-silence / crossfade）
@music stop                     // 停止 BGM（淡出）
@sfx door_slam                  // 一次性音效
```

`@music <name>` 的行为由引擎根据当前播放状态决定——无 BGM 时直接淡入，已有 BGM 时交叉淡入。脚本不区分。

---

### 4.6 交互原语

LS 把"打断剧情让玩家做点什么"拆成四个边界清晰的原语：

| 原语 | 强制性 | 评级 | 奖励 | 叙事分支 | 实现 |
|---|---|---|---|---|---|
| `@trick` | 强制卡关 | 无 | 无 | 无 | 引擎原生（触摸 / 运动） |
| `@minigame` | 可选·可跳 | 无 | 有（引擎侧） | 无 | WebView，下游 agent 生成 |
| `@choice` + `brave`/`safe` | 强制 | D20 / 无 | — | 有（真分支） | 引擎原生 |
| `@cg` | — | — | — | — | 下游按所选形态生成静态图、视频或动态漫画 |

#### 4.6.1 `@trick <type> "<prompt>"` — 嵌入式 trick

**定位**：强制的体感微交互，推进剧情前必须完成。本质是 `@pause` 的体感升级版——价值是"在场感"，不是输赢。

```
@trick hold "Hold your breath until he walks past."
@trick tap  "Tap fast to catch your breath before the next class."
@trick swipe "Wipe the steam off the mirror."
```

**语法约束**：

- 一行式，叶子指令，**无 body**。
- `<type>` 必须是下表 **6 个**锁定值之一；脚本不能新增、不能覆写。
- `"<prompt>"` 是给玩家看的一句祈使，兼作叙事粘合。不可为空串。
- 阈值（点几下 / 按多久 / 摇多狠）**写死在引擎**，脚本不传，无覆写块（YAGNI）。
- 无评级、无奖励、无叙事分支。要分支用 `@choice`。
- 引擎**原生**交互，**不进 WebView**——检测器 + prompt 浮层都在引擎内。

**锁定的 6 个 trick 类型**：

| type | 中文 | 模态 | 权限 | 能演什么 |
|---|---|---|---|---|
| `tap` | 连点 | 触摸 | 无 | 跑 / 挣扎 / 捶门 / 鼓掌 / 心跳 |
| `hold` | 长按 | 触摸 | 无 | 憋气 / 别动 / 按住伤口 / 忍住 |
| `swipe` | 滑动 | 触摸 | 无 | 擦镜 / 抹泪 / 推开 / 拉窗帘（纯方向，不跟路径） |
| `shake` | 摇 | 运动 | 无运行时弹窗 | 摇醒 / 摇瓶 / 发抖 / 地震 |
| `swing` | 挥动 | 运动 | 无运行时弹窗 | 挥剑 / 甩鱼竿 / 出拳 / 敲门 |
| `tilt` | 倾斜 | 运动 | 无运行时弹窗 | 探头看 / 侧耳听 / 偏头观察 / 倾斜躲避 |

**选型原则**（锁死依据）：

- trick 集是**调色盘**，覆盖情绪寄存器：动作（tap / shake / swing）、克制（hold）、空间感知（tilt：探头 / 侧耳）、方向手势（swipe）。
- **可靠性是及格线**，不是加分项——trick 是强制门，检测失败 = 玩家卡死。6 个全部是高可靠模态（触摸几何 / 运动几何），不含表情识别、不含麦克风、不含摄像头几何（运行时权限墙太重）。

**权限契约**：

- 触摸 trick：无权限。
- 运动 trick（`shake` / `swing` / `tilt`）：原生裸陀螺仪 / 加速度大概率**不弹运行时窗**。具体由 Loopit 端在最新 iOS 上验证。
- 6 个 trick 类型里不含摄像头、不含麦克风模态。

**与 `@pause` 的关系**：`@pause` 是隐形节奏（等一次点击），`@trick tap` 是有 prompt 与演出的实体动作——叙事意义不同，并存。

#### 4.6.2 `@minigame <name> "<description>"` — 独立小游戏

**定位**：嵌在剧情里的独立小游戏，玩完给奖励。可选——剧情把它递到面前，玩家可玩可跳。小游戏由下游 vibe-coding agent 按描述自动生成。CG 与 minigame 在描述方式上对称——都是 prose → 下游生成 agent（CG → 视频管线；minigame → vibe-coding agent）。

```
@minigame casino_showdown "Mauricio drags Malia into a backroom blackjack game — green felt, a low brass lamp, cigarette smoke, his friends watching — betting on who covers tonight's tab. The player taps to draw cards and taps Stand to hold, beating the dealer's hand without going over 21; three quick rounds. Win and Malia keeps her dignity; lose and she owes him a favor."
```

**语法约束**：

- `<name>`：素材句柄，对应 `assets.minigames.<name>`。
- `<description>`：**一整段连贯 prose，不分字段、不是 JSON**。同时干两件事：
  1. **衔接剧情**——什么场合、为何有这局、赌注 / 氛围、谁在场。
  2. **简单定义玩法**——玩家做什么、核心机制、怎样算赢。"简单"是关键：给方向，别写成设计文档。
- **无 body**——叶子指令。
- **无属性**（无 `<ATTR>`）——脱钩 D20 检定（D20 在 `@choice brave` 内部）。
- **无评级分支**——`rating.<grade>` 不是合法 condition 类型。
- **奖励全在引擎侧**——脚本不写金额、不写消耗。引擎根据 H5 回传的分数缩放奖励（反作弊在此），脚本保持精简。
- **跳过 = 整条 `@minigame` 当 no-op**，从其后继续，无奖励。

**describe 的质量靠 Skill 层**：写 describe 的创作 Skill 必须知道小游戏生产能力与复杂度上限；这些创作指引属于对应 Skill，**不进 LS 语法**。

#### 4.6.3 `@choice { }` — 强制选择 + D20

选择块，包含多个 `@option`。

```
@choice {
  @option A brave "Stand your ground." {
    check {
      attr: CHA
      dc: 12
    }
    @if (check.success) {
      @easton relieved
      EASTON: Can I sit?
      MALIA: You have two minutes.
      @affection easton +2
      @butterfly "Accepted Easton's approach at the cafeteria"
    } @else {
      @easton hurt
      MALIA: I... I can't do this.
      @butterfly "Tried to face Easton but lost courage"
    }
  }
  @option B safe "Have Mark make a scene." {
    @mark grin_mischief
    MARK: HEY EASTON! You want some of my mystery casserole?
    @mark bubble music
    YOU: Thank god for Mark.
    @butterfly "Had Mark create a diversion to avoid Easton"
  }
}
```

#### `@option <ID> <brave|safe> "<text>" { }`

- `ID`：选项编号（A / B / C...），用于条件回顾 `@if (A.success)`
- `brave`：需要 D20 检定，必须包含 `check { }` 块；结果分支用 `@if (check.success) { } @else { }`
- `safe`：跳过检定，块内直接是叙事内容

`brave` / `safe` 关键字保留——虽然有无 `check { }` 块本身就能区分两类，但显式关键字让 LLM 生成时更不易出错，写起来意图也更清晰。

**关于 check.success / check.fail 的省略**：validator 不强制"必须两个分支齐全"——`@if (check.success) { }` 只写 `then` 不给 `@else` 是合法的，省略时失败路径就是"什么都不发生"。这是剧作者的选择，不是语法错。

#### `check { }`

检定参数块，嵌套在 `@option brave` 内。属性名称不硬编码，脚本可自由使用任何名称（未来属性名变化时无需改语法）。

```
check {
  attr: CHA       // 检定属性
  dc: 12          // 难度值
}
```

D20 检定公式（引擎内置）：`D20(1-20) + 属性修正 >= DC → 成功`

`@minigame` 不绑定属性、不影响 D20——奖励完全在引擎侧（反作弊），脚本一个数字都不写。XP / SAN / reroll / coins / gems 等数值经济由引擎管理；脚本只能在 `@if` 里读引擎管理的数值。

---

### 4.7 状态变更

脚本只做声明，引擎负责实际计算和持久化。

```
@affection easton +2                             // 好感度
@butterfly "Accepted Easton's approach openly"   // 蝴蝶效应记录（喂下游内容生成 agent）
@signal mark HIGH_HEEL_EP05                      // 持久布尔标记
@signal int REJECTIONS +1                        // 持久整数变量
@achievement HIGH_HEEL_WARRIOR {                 // 成就解锁
  name: "Heel as Weapon"
  rarity: rare
  description: "You turned an accessory into a warning."
}
```

> **引擎管理的数值**（如 XP、SAN/HP 等）由引擎内部维护，脚本**不能**修改它们。脚本只能在 `@if` 条件中引用这些数值（如 `@if (san <= 20)`），具体名称由引擎定义。
>
> **作者自定义的 signal**（`mark` 和 `int`）统一使用英文 `SCREAMING_SNAKE_CASE`，必须匹配 `^[A-Z][A-Z0-9_]*$`。引擎管理的只读数值继续使用运行时声明的名称（例如小写 `san`）；大小写区分让两类状态不会互相冒充。`lsc validate` 会机械拦截不合规的作者 signal。

#### `@affection <char> <+/-N>`

调整角色好感度。引擎跨集存储。在 `@if` 中以 `affection.<char>` 形式查询。

#### `@butterfly "<description>"`

蝴蝶效应记录——记录玩家行为及其性格含义。

**用途**：供后续内容生成流程理解玩家性格画像，保持改写和衍生剧情与玩家行为模式的一致性。

**不参与运行时路由判定**——gate 求值不读 butterfly 累积，所有路由依赖 signal mark、signal int、affection、choice history 这些确定性状态。

描述用英文，写玩家行为与其性格含义，不是流水账。

#### `@signal <kind> <...>`

事件/状态信号。`kind` 必写。两种 kind：

| kind | 语法 | 用途 | 写入频率 |
|------|------|------|---------|
| `mark` | `@signal mark <event>` | 持久布尔标记，供 `@if (NAME)` 查询 | **稀有**（关键剧情点） |
| `int` | `@signal int <name> <op> <value>` | 持久整数变量，供 `@if (NAME <cmp> N)` 查询 | **自由**（计数/阈值） |

##### `@signal mark <event>`

持久布尔标记。引擎永久存储，在 `@if (NAME)` 条件中作为布尔值使用。**只用于关键剧情点**——触发隐藏剧情、成就解锁守卫。

`event` 可为裸标识符或双引号字符串。所有 `event` 名称使用 `SCREAMING_SNAKE_CASE` 英文，并匹配 `^[A-Z][A-Z0-9_]*$`。

###### Mark 不是"到此一游"标记

**Mark 必须是有人读的。** 不要每集结尾、每个选项出口顺手打 mark。写 mark 的流程是**反过来**的：

1. 先想清楚后面哪里有条件查询要用它——某集的 `@if (X)` 隐藏剧情？某处 `@if (X && Y) { @achievement ... }` 成就解锁？
2. 找到查询点后，反推 X 应该在哪里被打下
3. 只在那个点打 mark

**不需要打 mark 的情况，引擎已经帮你管了：**

- **"这集打完了"** → 引擎从 episode_id 就知道玩家进度
- **"玩家选了 A"** → 选项结果存在引擎的 choice 历史里，gate `@if (A.success)` 直接查
- **"好感度涨了"** → `@affection` 已经改过数值，`@if (affection.easton >= 5)` 直接查数值即可
- **"某个计数阈值"** → 用 `@signal int COUNTER +1` + `@if (COUNTER >= N)`，比开多个布尔 mark 清晰得多

**真正需要打 mark 的情况：**

- **隐藏剧情分支**：某集的一个关键举动，在后续集的某条对白里被引用。没这 mark 就没那句对白。
- **跨集 arc 成就**：两个或多个 mark 组合作为 `@if` 条件，守卫 `@achievement` 触发。
- **一次性关键抉择**：影响整个主线走向的决定性瞬间，后续多集都会反复查询。

**写-读配对示例：**

```
// EP05 —— write mark
MALIA: One quick step. My heel went straight through his shoe.
@signal mark HIGH_HEEL_EP05

// EP24 —— read mark in hidden-route branch
@if (HIGH_HEEL_EP05) {
  YOU: He glanced at my shoes. He remembered.
}

// 成就解锁 —— 触发和声明合二为一
@if (HIGH_HEEL_EP05) {
  @achievement HIGH_HEEL_WARRIOR {
    name: "Heel as Weapon"
    rarity: rare
    description: "You turned an accessory into a warning. Once is enough to go on record."
  }
}
```

##### `@signal int <name> <op> <value>`

持久整数变量。引擎跨集存储，支持赋值 / 增 / 减，供 `@if` 中裸名比较读取。适合"计数型剧情锁"——统计玩家被拒次数、累计同情行为、N 选 M 触发隐藏剧情等。

**三种写入形态：**

```
@signal int REJECTIONS = 0       // 赋值（无条件覆盖，value 可为负）
@signal int REJECTIONS +1        // 增
@signal int REJECTIONS -2        // 减
```

**语义：**

- **跨集持久**：与 `affection` / `mark` 同等生命周期
- **首次引用视为 0**：`+1` 之前从未赋值 → 引擎从 0 起算，结果为 1
- **统一命名**：作者 `int` 与 `mark` 一样使用 `SCREAMING_SNAKE_CASE`，如 `LOVE_POINTS`
- **`=` 无条件覆盖**：每次执行都赋值。把 `@signal int LOVE_POINTS = 0` 放在 ep01 顶部而玩家回放该集时变量会被重置为 0——是作者的责任
- **`+N` / `-N` 中 N 必须非负**：负增量用 `-N` 形态表达，`+0` / `-0` 无意义（用 `= 0`）

**读取（裸名，与引擎数值同语法）：**

```
@if (REJECTIONS >= 3) { ... }
@if (REJECTIONS == 0) { ... }
@if (REJECTIONS >= 3 && affection.easton < 2) { ... }

@gate {
  @if (REJECTIONS >= 3): @end bad_ending
  @else @if (BRAVE_COUNT >= 3): @next main/route/hidden:01
  @else: @next main:02
}
```

**与 mark 的使用文化区别：**

| 维度 | `@signal mark` | `@signal int` |
|------|----------------|---------------|
| 写入频率 | 稀有，必须有 reader | 自由，按业务需要 |
| 典型用途 | 一次性关键抉择、隐藏剧情前置、成就守卫 | 计数、累计、阈值型剧情锁 |
| 作者诫命 | "必须有人读，不要顺手打" | 无——计数器的本职就是被频繁修改 |

`@signal int` **不受** "marks 要克制" 的诫命约束；计数器天生就是要频繁写入的。但只给计数器命名有实际含义的名字，不要一个变量半途改语义。

#### MP 跨角色信号命名（cross-signal naming）

多人故事（MP）中，一个角色的关键选择会被铸造成一个跨角色信号（cross-signal），写入双方共享的 multiplayer 状态盒，**让对方的脚本能用 `@if (...)` 读到自己角色当前为止的选择**。命名格式由引擎统一铸造，作者不手写信号名——但写跨角色条件查询时**必须**理解格式，否则没法引用对方的选择。

**格式：**

```
mp_<role>_a<actIndex>_c<choiceIndex>_<optionId>
```

| 段 | 含义 | 来源 |
|------|------|------|
| `<role>` | 产出该选择的角色 roleKey（小写，例：`diego` / `seiya` / `ryu`） | 剧本声明的角色键 |
| `<actIndex>` | 该角色当前 act/episode 在自己 track 中的 0-indexed 序号 | 编译期由 LS 结构决定 |
| `<choiceIndex>` | 该 act 内、联合选择点（joint choice）按 DFS 文档顺序的 0-indexed 序号 | 编译期由 LS 结构决定 |
| `<optionId>` | 角色实际选中的 `@option` 字面 ID（例：`A` / `B` / `CONFRONT`） | 运行时由玩家选择决定 |

**核心性质：内容寻址（content-addressed），不是运行时寻址。**

信号名由"选择在故事里的位置"决定（角色 + act 序号 + 该 act 内 joint choice 的 DFS 文档序号 + 选中的 option ID），**不依赖**运行时 barrier 计数器或谁先谁后到达。这意味着：

- **重编译稳定**：同一份脚本无论编译多少次、玩家在哪个房间里运行，同一个选择产生的信号名都不变
- **可前向引用**：partner 的脚本可以在自己 act 写 `@if (mp_diego_a2_c0_A)`，引用 diego 还没到达的选择——读取时机由引擎调度，命名时不需要同步
- **位置 vs 时间**：信号名编码"这个选择在故事里的位置"，**不**编码"运行时什么时候到达"

**示例：**

`chaoreqi-idol` 故事中，diego 的 act 2（自己 track 的第 3 集，0-indexed = 2）按 DFS 文档顺序包含 3 个 joint choice。其中第 1 个（`choiceIndex = 0`）若玩家选了 option A，铸造的信号为：

```
mp_diego_a2_c0_A
```

seiya 的 track 可以在任意位置用条件查询门控：

```
@if (mp_diego_a2_c0_A) {
  SEIYA: I saw what Diego picked. The corner's mine now.
}
```

**对比历史命名（已废弃）：**

旧设计用 `mp_<role>_b<N>_<opt>`，其中 `<N>` 是运行时 barrier 计数器编号。该方案在编译 / 重编译间不稳定（barrier 编号会因脚本结构变化漂移）、要求双方运行时严格按 barrier 顺序同步、且无法在 partner 未到达前进行前向引用。当前实现已**整体替换**为本节描述的位置寻址命名，旧 `b<N>` 形态在 codebase 中不再出现。

**作者纪律：**

- **不要手写 `mp_*` 信号名做 `@signal mark`**——cross-signal 由引擎在跨角色选择点自动铸造，作者只能 `@if` 读
- **跨角色条件查询要做防御性书写**：partner 还没运行到那个选择点时该 `@if` 为 false，本角色脚本应能在 false 分支自然推进，不要强假设 partner 永远已到
- **roleKey 命名一旦上线不可改**：信号名里嵌了 roleKey，改名等于历史信号全失效；roleKey 一经发布须冻结

#### `@achievement <id> { name / rarity / description }`

成就指令——块内携带元数据，执行到这条节点就是解锁时机。条件触发由外层 `@if` 承担。

```
@if (HIGH_HEEL_EP05 && HIGH_HEEL_EP24) {
  @achievement HIGH_HEEL_DOUBLE_KILL {
    name: "Heel Twice Over"
    rarity: epic
    description: "Once is improvisation. Twice is a signature move."
  }
}
```

裸 `@achievement` 也合法（无条件解锁，但场景较少——大多数成就需要前置条件）。

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | 字符串 | 显示名称（英文，短且具象） |
| `rarity` | 标识符 | `uncommon` / `rare` / `epic` / `legendary`（**无 `common`**——成就必须需要有意识的玩家行为） |
| `description` | 字符串 | DM 口吻的 1-2 句英文 flavor 文本 |

**工作机制**：

1. 剧本在恰当的剧情节点用 `@signal mark NAME` 打下前置标记（如需多 mark 组合）
2. 剧本在解锁点写 `@achievement <id> { ... }`，通常包裹在 `@if (mark1 && mark2 && ...)` 里以确保所有前置条件成立
3. 引擎执行到该节点时走成就系统（UI 弹窗、成就页、数据上报）；同一 id 重复触发由引擎按 id 去重

**触发位置最佳实践**：放在最后一个依赖 mark 的打点之后——那时所有前置 mark 已就位，`@if` 一次性判定即可。

**格式约束**：
- `name` / `rarity` / `description` 三个字段都必填
- id 使用 `SCREAMING_SNAKE_CASE` 英文
- 缺 `{ }` 的裸 `@achievement <id>` 形式是 parse error

---

### 4.8 流程控制

#### `@if (<condition>) { }` / `@else @if (<condition>) { }` / `@else { }`

条件分支。条件必须用括号 `()` 包裹。支持 `&&`（与）和 `||`（或）。支持 `@else @if` 链式判定。

```
@if (affection.easton >= 5 && CHA >= 14) {
  EASTON: You remembered.
} @else @if (affection.easton >= 3) {
  EASTON: ...I wasn't sure you'd come.
} @else {
  EASTON: ...Hey.
}

@if (REJECTIONS >= 3 || FAILED_TWICE) {
  YOU: I can barely keep it together.
}
```

#### 条件类型（5 种）

所有类型都解析为结构化 AST，后端直接消费，无需再次解析表达式字符串。body `@if` 和 gate `@if` 均可使用（除 `check`）。

| 类型 | 源语法 | AST 输出 | 作用域 |
|------|------|---------|------|
| choice | `<ID>.<result>` | `{type:"choice", option, result}` | 任意位置（回顾性查询） |
| flag | `SIGNAL_NAME` | `{type:"flag", name}` | 任意位置 |
| comparison | `<operand> <op> <operand>` | `{type:"comparison", left, op, right}` | 任意位置 |
| compound | `expr && expr` / `expr \|\| expr` | `{type:"compound", op, left, right}`（递归嵌套） | 任意位置 |
| check | `check.success` / `check.fail` | `{type:"check", result}` | **仅 brave option 体内** |

##### choice

```
@if (A.fail): @next main/bad/001:01
@if (B.any): @next main:02
```

源语法：`<option_id>.<check_result>`（点号分隔）
- `option_id`：选项编号（A / B / C 等，对应 `@option` 的 ID）
- `check_result`：`success` | `fail` | `any`（`any` 表示无论成败均匹配）

##### flag

```
@if (EP01_COMPLETE): @next main/route/002:01
@if (HIGH_HEEL_EP05) { ... }
```

单个标识符，引擎查询该 signal 是否被触发过。

##### comparison

```
@if (affection.easton >= 5): @next main/route/001:01
@if (san <= 20): @end bad_ending
@if (affection.easton > affection.diego): @next main/route/easton:01
@if (MAX(affection.easton, affection.diego) >= 5) { ... }
@if (MIN(affection.easton, affection.diego, affection.mauricio) >= 3) { ... }
@if (MAX(affection.easton, affection.diego, affection.mauricio, affection.elias) >= 8) { ... }
@if (affection.easton > MAX(affection.diego, affection.mauricio, affection.elias)): @next main/route/easton:01
@if (5 < affection.easton) { ... }
```

数值比较。**左右两侧均可为任意 operand**——支持变量与变量比较、变量与字面量比较、聚合函数与任意值比较。

**操作符：** `>=` `<=` `>` `<` `==` `!=`

- 条件表达式不支持一元否定 `!`。需要否定布尔条件时交换 `@if` 与 `@else` 分支；比较运算符 `!=` 仍然合法。

**Operand AST 共 5 种 `kind`**，分 4 类：

| 形态 | 源语法 | AST kind | 说明 |
|------|-------|----------|------|
| 字面量 | `5` / `-2` | `literal` → `{kind:"literal", value:N}` | 整数字面量 |
| affection | `affection.<char>` | `affection` → `{kind:"affection", char:"..."}` | 角色好感度 |
| value | `<name>` | `value` → `{kind:"value", name:"..."}` | 引擎数值（`san` / `cha` 等）或作者 `@signal int` 变量。引擎裸名查找，两类共享命名空间 |
| 聚合 | `MAX(<op>, <op>, <op>, ...)` / `MIN(<op>, <op>, <op>, ...)` | `max` → `{kind:"max", args:[...]}` 或 `min` → `{kind:"min", args:[...]}` | 取所有 args 中的最大/最小值。**args 数量任意，下限 2 个、无上限**——比较两个 LI、三个 LI、四个甚至更多角色的好感度都用同一语法。args 中的 operand 可以是任何 kind（含递归嵌套的 MAX/MIN） |

**`MAX` / `MIN` 是保留字**——signal mark 名、signal int 名、引擎数值名都不可与之冲突。

**约束**：
- 比较两侧 operand 必须同为整数类型（validator 校验）
- 聚合函数 args 全部为整数类型 operand，**args 列表长度 ≥ 2**（1 个 arg 的 MAX/MIN 是 parse error，因为退化为该 arg 本身、写聚合没有意义）
- 大小写敏感：`MAX` / `MIN` 必须全大写；小写 `max` / `min` 只有在运行时把它们声明为引擎数值时才是合法裸名，不能作为作者 signal

##### compound

通过 `&&`（与）、`||`（或）组合任意其他条件类型。支持括号分组。优先级：`||` 低于 `&&`。

```
@if (san <= 20 || FAILED_TWICE): @end bad_ending
@if ((A.success || B.success) && affection.easton >= 3): @next main/route/002:01
@if (MAX(affection.easton, affection.diego) >= 5 && CHA >= 14) { ... }
```

##### check

```
@if (check.success) { ... }
@if (check.fail) { ... }
```

**仅在 brave option 体内合法**——查询当前选项刚刚的检定结果。

**check vs choice 两种 D20 条件的区别**：
- `check.success`/`check.fail` 只在 brave option 体内合法——"此 option 刚刚的检定成了吗？"（当前局部）
- `A.success`/`A.fail`/`A.any` 在任意位置合法——"玩家之前选了 A 选项且检定结果是？"（历史回顾）

在 option A 体内写 `A.success` 是冗余但合法的；写 `check.success` 更自然。

---

### 4.9 并发控制

LS 用 `@` 和 `&` 两种前缀区分指令的时序关系。

#### 时序语义

| 前缀 | 含义 | 角色 |
|------|------|------|
| `@` | 顺序执行，开启新的步骤组 | **领导者**（leader） |
| `&` | 并发执行，加入前一个步骤组 | **跟随者**（follower） |
| （无前缀） | 对话行，始终独立——等待玩家点击 | **独立** |

#### 工作原理

`@` 指令开启一个新的步骤组。紧随其后的 `&` 指令加入同一组，与 `@` 指令同时执行。遇到下一条 `@` 指令或对话行时，当前组关闭。

```
// 场景搭建——三条指令并发执行
@bg set school_hallway fade
&music tense_strings
&mauricio neutral_smirk

// 对话——每行独立，等待玩家点击
NARRATOR: The hallway fell silent.
MAURICIO: Hey, Butterfly.
```

上例中 `@bg`、`&music`、`&mauricio` 构成一个并发组，引擎同时执行三条指令。两条对话行各自独立，逐条推进。

#### 适用范围

`&` 可用于所有**简单指令**（背景、角色、音频、状态变更等）。

**不可用于块结构指令：**
- `@choice { }` — 选择块
- `@phone { }` — 手机界面块
- `@if { }` — 条件分支块
- `@gate { }` — 路由声明块

块结构指令必须用 `@` 前缀独立执行。

`@trick`、`@minigame`、`@cg` 是叶子指令（无 body），原则上**允许 `&` 并发前缀**——但叙事上几乎总是想让它独占一个步骤，建议保持 `@` 顺序执行，避免与其他动作混入同一组。

#### 典型用法

**场景切换**——背景、音乐、角色同步切换：

```
@bg set school_cafeteria fade
&music casual_lunch
&mark grin_confident
```

**角色同时动作**——角色变换 + 气泡同步：

```
@mauricio arms_crossed_angry
&josie bubble sweat
```

注意：在"同屏一人"规则下，同时显示多个角色的并发组其实只有最后一个角色被显示（前面的会被自动覆盖）。`&` 主要用于"角色 + 背景 + 音乐"或"角色 + 气泡"等不同类别的同步。

---

## 5. 素材映射

### 5.1 设计原则

脚本和素材映射**分离**：
- 脚本只写语义名（如 `malias_bedroom_morning`、`neutral_smirk`）
- 素材映射表是独立文件，由 Lunaverse IDE 素材管线生成维护
- 解释器将两者结合：`lsc compile script.ls --assets mapping.json -o output.json`

分离的好处：
- 同一套脚本可指向不同 OSS 环境（开发/生产/测试）
- 素材更新（换 URL、换 CDN）不需要改脚本
- 素材管线和剧本管线可以独立迭代

### 5.2 映射表格式

```json
{
  "base_url": "https://oss.mobai.com/novel_001",
  "assets": {
    "bg": {
      "malias_bedroom_morning": "bg/malias_bedroom_morning.png",
      "school_hallway": "bg/school_hallway.png",
      "school_cafeteria": "bg/school_cafeteria.png"
    },
    "characters": {
      "mauricio": {
        "neutral_smirk": "characters/mauricio_neutral_smirk.png",
        "arms_crossed_angry": "characters/mauricio_arms_crossed_angry.png"
      },
      "malia": {
        "neutral_phone": "characters/malia_neutral_phone.png",
        "worried": "characters/malia_worried.png"
      },
      "easton": {
        "vulnerable_hopeful": "characters/easton_vulnerable_hopeful.png",
        "relieved": "characters/easton_relieved.png",
        "hurt": "characters/easton_hurt.png"
      }
    },
    "music": {
      "calm_morning": "music/calm_morning.mp3",
      "tense_strings": "music/tense_strings.mp3"
    },
    "sfx": {
      "crowd_noise": "sfx/crowd_noise.mp3"
    },
    "cg": {
      "window_stare": "cg/window_stare.mp4"
    },
    "minigames": {
      "qte_challenge": "minigames/qte_challenge/index.html"
    }
  }
}
```

### 5.3 解析规则

| 脚本指令 | 映射路径 | 完整 URL |
|---------|---------|---------|
| `@bg set malias_bedroom_morning` | `assets.bg.malias_bedroom_morning` | `{base_url}/bg/malias_bedroom_morning.png` |
| `@mauricio neutral_smirk` | `assets.characters.mauricio.neutral_smirk` | `{base_url}/characters/mauricio_neutral_smirk.png` |
| `@music calm_morning` | `assets.music.calm_morning` | `{base_url}/music/calm_morning.mp3` |
| `@sfx crowd_noise` | `assets.sfx.crowd_noise` | `{base_url}/sfx/crowd_noise.mp3` |
| `@cg window_stare "..."` | `assets.cg.window_stare` | `{base_url}/cg/window_stare.webp` 或 `.mp4`（由所选生产形态决定） |
| `@minigame qte_challenge "..."` | `assets.minigames.qte_challenge` | `{base_url}/minigames/qte_challenge/index.html`（由 vibe-coding agent 生成后填入） |
| `@trick tap "..."` | — | 无素材（引擎原生） |

映射表中找不到的语义名 → 解释器报错（validate 模式下）或输出 warning + 空 URL（compile 模式下）。

---

## 6. 解释器

### 6.1 概述

Go 单二进制工具 `lsc`。

```bash
lsc compile 01.ls --assets mapping.json -o ep01.json        # 单集编译
lsc compile main/ --assets mapping.json -o novel.json        # 批量编译整个目录
lsc decompile ep01.json                                      # 反编译为 episode.ls + assets_mapping.json
lsc validate 01.ls --assets mapping.json                     # 验证（不输出 JSON）
```

### 6.2 核心职责

1. **解析**：将自定义语法解析为 AST
2. **验证**：语法正确性、引用完整性、保留字冲突检查
3. **素材映射**：通过映射表将语义名翻译为完整 OSS URL
4. **输出 JSON**：前端播放器可直接消费的结构化数据
5. **反编译**：从已编译 JSON 恢复 LS 源文件，并从 URL 字段抽取素材映射

### 6.3 JSON 输出概览

详细字段定义见 `docs/JSON-OUTPUT.md`。这里只给概览。

**顶层结构**：

```json
{
  "episode_id": "main:01",
  "branch_key": "main",
  "seq": 1,
  "title": "Butterfly",
  "steps": [ ... ],
  "gate": { ... } | null,
  "ending": { ... } | null
}
```

`gate` 与 `ending` 的取舍由编译器根据源 `@gate` 块的内容决定：
- 纯无条件 `@gate { @end TYPE }` → `gate: null, ending: {type: TYPE}`（legacy 形态，便于前端与 overlay 系统平滑过渡）
- 其他所有情形（无条件 `@next`、条件路由、`@end` 与 `@next` 混合）→ `gate: <AST>, ending: null`。gate AST 的叶子节点是 `{next: <branch_key>}` 或 `{end: <type>}`

**Step 类型分类**：

- 视觉：`bg`、`char_show`、`bubble`、`cg_show`
- 对话：`dialogue`、`narrator`、`you`
- 时序：`pause`
- 手机：`phone_show`、`text_message`
- 音频：`music`、`music_stop`、`sfx`
- 交互：`choice`、`minigame`、`trick`
- 状态：`affection`、`signal`、`achievement`、`butterfly`
- 流程：`if`

**关键设计**：
- 所有 step 带稳定 `id` 字段（cursor 锚点，冻结契约——详见 JSON-OUTPUT.md §4.0）
- 所有 `character` 字段在 JSON 中**统一为小写**（脚本中 `MAURICIO:` → JSON 中 `"mauricio"`）
- URL 已解析，前端不需要二次拼接
- `steps` 是混合数组：对象 = 单步骤，数组 = 并发组（同时执行）
- 嵌套只出现在有分支的地方（`choice.options[].steps`、`if.then`/`if.else`、`phone_show.messages`、gate AST）
- 条件 AST **完全结构化**，不含表达式字符串，后端可直接遍历判定

---

## 7. Remix 兼容

### 7.1 Remix 输出格式

改写流程输出标准 `.ls` 文件，与其他 canonical episode 文件格式完全一致。

### 7.2 两种生命周期

**完整集替换**：Remix 生成一集或多集完整内容，放在 `remix/<session_id>/` 目录下。

**选择后片段**：用户输入替换了原 `@choice`，Remix 生成从选择点之后的全部内容，作为完整 `@episode` 输出。

### 7.3 示例

```
@episode remix/abc123:01 "Mark's Casserole Incident" {

  @mark grin_mischief
  MARK: FOOD FIGHT!
  @sfx crowd_noise

  NARRATOR: The cafeteria descended into chaos.
  YOU: This is either the best or worst idea Mark has ever had.

  @butterfly "Mark 发起了食堂食物大战"

  @gate {
    @next main:02
  }
}
```

### 7.4 回归机制

- **回归主线**：`@gate { @next main:02 }`
- **不回归**：`@gate { @next remix/abc123:02 }`（指向自己的下一集）
- **条件回归**：用 `@if` + `@else` 组合

---

## 附录 A：Episode 1 完整脚本

```
@episode main:01 "Butterfly" {

  // ===== 场景一：Malia 卧室，清晨 =====

  @bg set malias_bedroom_morning
  &music calm_morning
  &malia neutral_phone

  NARRATOR: Senior year. Day one. Status: already complicated.
  YOU: Another year. Same mess.

  @phone {
    @text from EASTON: Can we talk? I miss you.
    @text from EASTON: I know I messed up.
  }

  YOU: Eight months and he still won't stop.
  @malia worried

  // ===== 场景二：学校门口 =====

  @bg set school_front fade
  &music upbeat_school

  JOSIE [cheerful_wave]: Malia! Over here!
  @josie bubble heart
  MALIA [neutral_flat]: Hey, Jo.
  JOSIE: New year, new Malia. That's the plan, right?
  YOU: If only it were that simple.

  // ===== 场景三：走廊 =====

  @bg set school_hallway fade
  JOSIE [nervous_whisper]: Don't look. Three o'clock.

  MAURICIO [neutral_smirk]: Hey, Butterfly.
  @josie bubble sweat
  @trick hold "Hold your breath until he walks past."
  YOU: He hasn't called me that in eight years.

  // ===== 场景四：教室 + 小游戏 =====

  @bg set school_classroom fade
  &music tense_strings

  NARRATOR: Mr. Chen paired them together. Of course he did.

  @minigame qte_challenge "Mr. Chen pairs Malia and Mauricio for the opening reading exercise — they trade lines from Jane Eyre while the rest of the class watches to see who flinches first. The player taps to match Malia's pacing to a rhythm meter, recovering after each misstep so she keeps her composure; three short rounds, best timing wins. Win and Malia reads the closing line with a steady voice; stumble and Mauricio finishes it for her."

  // ===== 场景五：食堂 + 核心选择 =====

  @bg set school_cafeteria fade
  &music casual_lunch

  MARK [grin_confident]: Yo, Malia! Sit with us!
  @sfx crowd_noise

  NARRATOR: Easton is walking toward your table.

  @choice {
    @option A brave "Let him come." {
      check {
        attr: CHA
        dc: 12
      }
      @if (check.success) {
        @signal mark EASTON_APPROACHED_EP01
        EASTON [relieved]: Can I sit?
        MALIA: You have two minutes.
        @affection easton +2
        @signal int EASTON_APPROACHES_ACCEPTED +1
        @butterfly "Accepted Easton's approach at the cafeteria"
      } @else {
        EASTON [hurt]: ...
        MALIA: I... I can't do this.
        EASTON: Malia, please
        MALIA: Not here. Not now.
        @butterfly "Tried to face Easton but lost courage"
      }
    }
    @option B safe "Have Mark make a scene." {
      MARK [grin_mischief]: HEY EASTON! You want some of my mystery casserole?
      @mark bubble music
      YOU: Thank god for Mark.
      @butterfly "Had Mark create a diversion to avoid Easton"
    }
  }

  // ===== 场景六：体育馆 =====

  @bg set school_gymnasium fade
  &music ambient_gym

  JOSIE [excited]: Did you see Elias in practice today?
  YOU: I was trying not to.

  ELIAS [neutral_calm]: ...

  NARRATOR: He didn't say a word. He didn't have to.
  @malia bubble heart

  // ===== 场景七：夜晚卧室 =====

  @bg set malias_bedroom_night fade
  &music night_piano

  YOU: Day one. Survived. Barely.

  @phone {
    @text from UNKNOWN: nice curtains, Butterfly
  }

  @malia shocked
  YOU: ...How does he know which window is mine?

  // ===== 路由 =====

  @gate {
    @if (A.fail): @next main/bad/001:01
    @else @if (affection.easton >= 3 && A.success): @next main/route/001:01
    @else: @next main:02
  }
}
```

---

## 附录 B：指令速查表

| 指令 | 说明 |
|------|------|
| `@episode <branch_key> "<title>" { }` | 集定义 |
| `@gate { }` | 路由声明（集尾部，必填且唯一） |
| `@if (<condition>): @next <branch_key>` | gate 内跳转分支 |
| `@if (<condition>): @end <type>` | gate 内终结分支（`complete`/`to_be_continued`/`bad_ending`） |
| `@else @if (<condition>): ...` | gate 内链式分支 |
| `@else: ...` | gate 内兜底分支 |
| `@pause` | 等待玩家点击一次 |
| `@<char> <pose> [transition]` | 角色显示/换 pose（首次=入场） |
| `@<char> bubble <type>` | 气泡动画 |
| `@bg set <name> [transition]` | 切背景 |
| `@cg <name> "<content>"` | CG（leaf，下游按所选形态生产） |
| `CHARACTER: text` | 对白（自动显示说话角色） |
| `CHARACTER [pose]: text` | 对白糖（等价于 `@character pose` + 对白） |
| `NARRATOR: text` | 旁白（清空所有立绘） |
| `YOU: text` | MC 内心独白（显示 MC 立绘） |
| `@phone {`<br>`  @text from/to ...`<br>`}` | 手机界面（必须多行；块内只允许静音 UI 文本 `@text`，不触发配音） |
| `@text from <char>: content` | 收到消息 |
| `@text to <char>: content` | 发出消息 |
| `@music <name>` | 播放 BGM（引擎自动 from-silence / crossfade） |
| `@music stop` | 停止 BGM（淡出） |
| `@sfx <name>` | 一次性音效 |
| `@minigame <name> "<description>"` | 可选小游戏（leaf；下游 vibe-coding agent 生成） |
| `@trick <type> "<prompt>"` | 强制 trick（leaf；type ∈ tap/hold/swipe/shake/swing/tilt） |
| `@choice { }` | 选择块 |
| `@option <ID> <brave\|safe> "<text>" { }` | 选项；brave 必含 `check { }` |
| `check { attr / dc }` | 检定参数（嵌套在 brave 选项内） |
| `@affection <char> <+/-N>` | 好感度变化 |
| `@signal mark <event>` | 持久布尔标记。`@if (NAME)` 查询。克制使用——必须有 reader |
| `@signal int <name> (=\|+\|-) <int>` | 持久整数变量。`@if (NAME <cmp> ...)` 查询 |
| `@achievement <id> { name / rarity / description }` | 成就解锁 |
| `@butterfly "<description>"` | 蝴蝶效应记录（喂下游内容生成 agent，不参与路由） |
| `@if (<condition>) { } / @else @if / @else` | body 条件分支 |
| `MAX(<op>, <op>, ...)` / `MIN(<op>, <op>, ...)` | comparison 内的聚合 operand（保留字） |
| `&<指令>` | 并发前缀，与前一条 `@` 同时执行（不可用于块结构） |

### 保留字

以下标识符不可用作 signal mark 名、signal int 名、pose 名：

- 指令动词：`set`、`bubble`、`from`、`to`、`stop`
- 流程关键字：`if`、`else`、`next`、`end`、`gate`、`episode`、`choice`、`option`、`check`、`pause`
- 选项模式：`brave`、`safe`
- ending 类型：`complete`、`to_be_continued`、`bad_ending`
- 聚合函数：`MAX`、`MIN`
- 检定属性命名空间：`check`
- D20 检定结果：`success`、`fail`、`any`

具体保留字清单由 validator 维护并随版本更新。

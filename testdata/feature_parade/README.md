# Feature Parade — LS 全功能压测集

极简剧情 × 全功能覆盖 × 对白即测试清单。每个剧本里的旁白/对白都用 `[T##]` 标注当前测试点，播放时对照本文件勾选即可知进度。

## 文件结构

```
feature_parade/
├── README.md              # 本文件（含完整测试清单）
├── mapping.json           # 素材映射（指向 OSS）
├── ep01.md                # 主剧本（T1–T29）
├── ep02.md                # 补全剧本（T30–T35）+ @gate { @end complete }
├── bad01.md               # gate @end bad_ending 终态（T37/T41/T42）
├── cont01.md              # gate @end to_be_continued 终态（T43–T45）
├── stress.md              # 高强度逻辑压测（T50–T60）
├── ep01_output.json       # 编译产物（golden）
├── ep02_output.json
├── bad01_output.json
├── cont01_output.json
├── stress_output.json
└── assets/                # 素材本地副本（OSS 镜像见下）
    ├── bg/                # 6 张背景
    ├── characters/        # 6 角色 × 16 立绘
    ├── music/             # 6 首 BGM
    ├── sfx/               # 3 个音效
    ├── cg/                # 1 张 CG
    └── minigames/         # 5 个真实小游戏
        ├── parking-rush/
        ├── power-swing/
        ├── slot-machine/
        ├── stardew-fishing/
        └── survive-30-seconds/
```

## 跑通方式

```bash
make build

# 单文件
bin/lsc validate testdata/feature_parade/ep01.ls --assets testdata/feature_parade/mapping.json
bin/lsc compile  testdata/feature_parade/ep01.ls --assets testdata/feature_parade/mapping.json -o /tmp/ep01.json

# 全部重生成 golden
for f in ep01 ep02 bad01 cont01 stress; do
  bin/lsc compile testdata/feature_parade/$f.md \
    --assets testdata/feature_parade/mapping.json \
    -o testdata/feature_parade/${f}_output.json
done
```

## OSS 素材

已上传至 `https://mobai-file.oss-cn-shanghai.aliyuncs.com/moonshort-script/testdata/feature_parade/`，包含：

- 6 背景 / 16 立绘 / 6 BGM / **3 SFX（bell 钟声 / crowd 狗笑 / huh "huh?"）** / **1 CG 视频（cg_example.mp4）**
- **5 个可玩小游戏**（用户提供的 minigames-example）：
  - `minigames/parking-rush/index.html` — 停车冲刺
  - `minigames/power-swing/index.html` — 时机挥击
  - `minigames/slot-machine/index.html` — 老虎机
  - `minigames/stardew-fishing/index.html` — 钓鱼
  - `minigames/survive-30-seconds/index.html` — 30 秒闪避生存

mapping.json 的 `base_url` 指向 OSS 根路径；minigame key 为下划线风格（`parking_rush`），映射到带连字符的真实文件夹（`parking-rush/`）。

---

## 测试清单（按对白编号勾选）

### EP01 —— 主剧本（T1–T29）

| # | 测试点 | 指令/特性 |
|---|---|---|
| T1 | 并发组：bg + music + char_show 同组 | `@bg` + `&music` + `&<char> <pose>` |
| T2 | 内心独白 | `YOU:` |
| T3 | 旁白 | `NARRATOR:` |
| T4 | 角色对白 | `CHARACTER:` |
| T5 | 收到消息 | `@text from` |
| T6 | 发出消息 | `@text to` |
| T7 | 手机块多条消息 | `@phone { ... }` |
| T8 | 立绘语法糖（第 1 次） | `CHARACTER [pose]:` |
| T9 | bg transition=fade + 隐式 music 切换 | `@bg set ... fade` + `&music <name>`（与前一首 music 自动 crossfade） |
| T10 | 气泡全 9 种 | `@<char> bubble`：heart/anger/sweat/question/exclaim/idea/music/doom/ellipsis |
| T11 | 连续 2 个 `@pause` | `@pause` ×2（重复表达长 pause） |
| T12 | bg transition=cut + 同屏一人换角色 + sfx | `@bg ... cut` + `&<char> <pose>` 覆盖 + `&sfx <name>` |
| T13 | 替换上一个角色后的对白 | `CHARACTER:`（验证"同屏一人"规则下隐式覆盖） |
| T14 | 隐式清场 | NARRATOR 行后无显式 hide —— 新 spec 不再需要 `@char hide` |
| T15 | bg transition=slow + 同屏一人多次换 char | `@bg ... slow` + `@<char> <pose>` 顺序覆盖 |
| T16 | minigame **parking_rush** (leaf) — 仅 prose 一行 | `@minigame <name> "<description>"`（无 ATTR、无 body、无 rating） |
| T16t | trick **tap** — engine-native body-interaction | `@trick tap "<prompt>"` |
| T17 | 对白铺垫 | `CHARACTER:` |
| T18 | 选择块设置 | `@choice` |
| T19 | brave 选项 + check block | `@option brave` + `check { attr dc }` + `check.success` / `check.fail` |
| T19note | D20 公式 | `D20(1-20) + 属性修正 ≥ DC` |
| T20 | 状态指令组：`@affection` / `@butterfly` / `@signal mark` / `@signal int` | 4 个状态指令一字排开 |
| T21 | 成就 rarity=uncommon | `@achievement` |
| T22 | safe 选项 | `@option safe`（无 check） |
| T23 | 顶层 @if 链：compound(comparison && flag) / compound(comparison \|\| flag) / @else | `@if` + compound condition |
| T24 | CG leaf（素材是 mp4 视频）；对白/旁白挪到 leaf 之前/之后 | `@cg <name> "<prose>"`（leaf，无 block，无 duration/transition） |
| T25 | operand-vs-operand 比较（affection.easton vs affection.mauricio） | `@if (affection.easton > affection.mauricio)` |
| T25m | MAX(...) 聚合 operand ≥ N | `@if (MAX(affection.easton, affection.mauricio, affection.elias) >= 5)` |
| T25n | MIN(...) 聚合 operand ≥ 0 | `@if (MIN(affection.easton, affection.mauricio, affection.elias) >= 0)` |
| T26 | engine value 比较（san） | `@if (san <= N)` / `@if (san >= N)` |
| T27 | 音乐停止 | `@music stop` |
| T28 | 立绘语法糖（第 2 次） | `CHARACTER [pose]:` |
| T29 | Gate 路由 4 种 gate-合法 condition + `@end` 与 `@next` 同 gate 混搭 | 见下表 |

**T29 Gate 路由详表**

真正的 `@gate` 之前放了一段**镜像 @if 链**——条件顺序与 gate 1:1 对应——在跳转发生前由 narrator 说出即将跳去哪一集（或 `@end`），方便测试时对照：

| 分支 | 条件类型 | 条件 | 预告对白 | 终态 |
|---|---|---|---|---|
| T29a | comparison（signal int） | `REJECTIONS >= 3` | `[T29a → @end bad_ending]` 计数器命中 → 直接 `@end bad_ending`（叶子） | `@end bad_ending` |
| T29b | choice | `A.fail` | `[T29b → main/bad/001:01]` | [bad01.md](bad01.md) |
| T29c | flag | `EP01_DEFLECTED` | `[T29c → main/bad/001:01]` | [bad01.md](bad01.md) |
| T29d | comparison（affection） | `affection.easton < 0` | `[T29d → main/bad/001:01]` | [bad01.md](bad01.md) |
| T29e | compound | `EP01_COMPLETE && affection.easton >= 3` | `[T29e → main/route/easton:01]` | [cont01.md](cont01.md) |
| T29f | comparison（operand vs operand） | `affection.easton > affection.mauricio` | `[T29f → main/route/easton:01]` | [cont01.md](cont01.md) |
| T29g | fallback | `@else` | `[T29g → main/stress:01]` | [stress.md](stress.md) → [ep02.md](ep02.md) |

T29a 的叶子是 `@end bad_ending`（非 `@next`），其余分支是 `@next`——验证同一 gate 内 `@end` / `@next` 混搭。

### 路由总览（5 个 ep 如何串起来）

```
                       ┌── [T29a]      counter ─→ @end bad_ending（gate 内叶子，无跳转目标 ep）
                       │
                       ├── [T29b/c/d] bad path ─→ bad01.md → @gate { @end bad_ending }
    ep01.md ──gate─────┤
  (main:01)            ├── [T29e/f]   route ────→ cont01.md → @gate { @end to_be_continued }
                       │
                       └── [T29g]     fallback ─→ stress.md ──gate──@next──→ ep02.md → @gate { @end complete }
                                                  (main/stress:01)            (main:02)
```

**默认路径**（所有条件都不命中时）：`ep01 → stress → ep02 (@end complete)` —— 按剧情跑一遍就能覆盖全部 5 个剧本。提前命中 T29a-T29f 中任一条则在对应终态停下。

### EP02 —— 补全剧本（T30–T35）

| # | 测试点 | 指令/特性 |
|---|---|---|
| T30 | char_show 新语法（无 position） | `@<char> <pose>`（位置由引擎从 gamestate.MC 派生） |
| T31 | char_show transition=dissolve（换 pose） | `@<char> <pose> dissolve` |
| T32 | 比较运算符 ==/!= | `@if (x == N)` / `@if (x != N)` |
| T33 | 比较运算符 >/< | `@if (san > N)` / `@if (san < N)` |
| T34 | 成就 rarity rare / epic / legendary | `@achievement ... { rarity: rare \| epic \| legendary }` |
| T35 | `@gate { @end complete }` | gate-only 终态（spec 已删除顶层 `@ending`） |

### BAD01 —— gate @end bad_ending（T37/T41/T42）

| # | 测试点 | 指令/特性 |
|---|---|---|
| T37 | 普通剧情行 | `NARRATOR:` / `YOU:` |
| T41 | 终局铺垫 | `@<char> <pose>` + `@music stop` |
| T42 | `@gate { @end bad_ending }` | 终态由 gate 叶子表达 |

> 旧 spec 的 `@label` / `@goto` 已删除，用 `@if` / `@else` 表达跳转语义；bad01 现在只是一个简短的终态片段。

### CONT01 —— gate @end to_be_continued（T43–T45）

| # | 测试点 | 指令/特性 |
|---|---|---|
| T43 | 路由入口叙述 | `NARRATOR:` |
| T44 | 承接 | `YOU:` |
| T45 | `@gate { @end to_be_continued }` | 终态由 gate 叶子表达 |

### STRESS —— 高强度逻辑（T50–T60）

| # | 测试点 | 指令/特性 |
|---|---|---|
| T50 | 压测起始宣告 + `@sfx huh` (T50a) | `@sfx <name>` 第 3 种音效 |
| T51 | 3 层 @if 嵌套（L1–L3） | `@if { @if { @if {} } }` |
| T52 | 复合条件括号优先级：`((x\|\|y) && (z\|\|w))` | `compound` |
| T53 | 复合条件并集：`(a && b) \|\| (c && d)` | `compound` |
| T54 | 一条 @if 链混合 5 种 gate-合法 condition + 1 个 signal-int comparison | choice / flag / signal-int comparison / comparison-affection / comparison-value / compound |
| T54x | MAX/MIN 聚合 operand + operand-vs-operand 比较 | 见下细分 |
| T55 | minigame **power_swing** leaf 形态 | `@minigame <name> "<description>"` |
| T55t | trick 全 6 类型连发 | `@trick tap/hold/swipe/shake/swing/tilt` |
| T56 | brave 省略 @else + safe 嵌套 @if | `@option brave` / `@option safe` |
| T57 | 单消息 `@phone { ... }` 边界 | 最小非空 phone 块 |
| T58 | 并发组边界：对话打断 + 重启 | `&` / 对话行 |
| T58a | 单个 `@pause` | `@pause` |
| T58b | `@signal int` — 3 种写法（=, +, -）+ comparison 读 | `@signal int STRESS_COUNT = 0` / `+2` / `-1` + `@if (STRESS_COUNT >= 2)` |
| T59 | 小游戏巡礼：**slot_machine / stardew_fishing / survive_30_seconds** | 3 个 leaf `@minigame` 连跑 |
| T60 | stress gate 路由：纯 `@next main:02` 无条件叶子 | gate 内单条无条件 `@next` |

**T54x MAX/MIN 聚合 + operand-vs-operand 详表**

| 分支 | 形态 | 示例条件 |
|---|---|---|
| T54x-a | 2-arg MAX | `MAX(affection.easton, affection.mauricio) >= 3` |
| T54x-b | 3-arg MIN | `MIN(affection.easton, affection.mauricio, affection.elias) >= 1` |
| T54x-c | 4-arg MAX | `MAX(..., ..., ..., ...) >= 5` |
| T54x-d | 混合 kind MAX（affection + value + literal） | `MAX(affection.easton, san, 3) >= 4` |
| T54x-e | 递归嵌套 MAX(MIN(...)) | `MAX(affection.easton, MIN(affection.mauricio, affection.elias)) >= 2` |
| T54x-f | operand-vs-operand（affection vs affection） | `affection.easton > affection.mauricio` |
| T54x-g | operand-vs-operand（聚合 vs 聚合） | `MAX(...) > MIN(...)` |
| T54x-h | literal-left comparison | `5 < affection.easton` |

---

## 覆盖矩阵汇总

### AST Node（25/25 全覆盖）

Episode, GateBlock, NextLeaf, EndLeaf, EndingNode, PauseNode, BgSetNode, CharShowNode, CharBubbleNode, CgShowNode, DialogueNode, NarratorNode, YouNode, PhoneShowNode, TextMessageNode, MusicSetNode, MusicStopNode, SfxNode, MinigameNode, TrickNode, ChoiceNode, OptionNode, AffectionNode, SignalNode, AchievementNode, ButterflyNode, IfNode

> 备注：`EndingNode` 是 emitter-only 简单终态标记（仅当 gate 形态是纯 `@gate { @end TYPE }` 时由 lowering 阶段产生），feature_parade 的 ep02/bad01/cont01 的纯 `@end` gate 触发该路径；T29 的混搭 gate 则保留 `GateBlock` AST、不产生 `EndingNode`。

### Condition（5/5 全覆盖）

| Condition | 覆盖位置 |
|---|---|
| `choice` | T29b gate / T54a stress / T56 brave inside check |
| `flag` | T29c gate / T23 ep01 / T54b stress |
| `comparison` | T23/T26 ep01 / T29a/T29d/T29f gate / T32/T33 ep02 / T51/T54c/T54d/T54e/T58b stress / T25 ep01（operand-vs-operand） |
| `compound` | T23 ep01 / T29e gate / T52/T53/T54f stress |
| `check` | T19a/T19b ep01 / T56a stress（均在 brave option 体内，context-local，gate 内不可用） |

> 旧 `influence` condition 已从 spec 移除；其原本职责由 signal-int comparison 替代（参见 T54c / T58b）。

### Operand kind（5/5 全覆盖）

| Operand kind | 覆盖位置 |
|---|---|
| `literal` | T26 / T32 / T33 / T58b / T54x-d / T54x-h（任何比较右侧的数字） |
| `affection` | T23 / T25 / T29d / T54x-a/b/c/e/f/g |
| `value` | T26 / T33 / T51 / T54e / T54x-d（`san`） |
| `max` | T25m / T54x-a/c/d/e/g |
| `min` | T25n / T54x-b/e/g |

聚合 operand 数量覆盖：2-arg（T54x-a） / 3-arg（T54x-b / T25m / T25n） / 4-arg（T54x-c） / 递归嵌套（T54x-e）。

### 属性覆盖（仅 brave option check 用；minigame/trick 不绑属性）

| 属性 | 覆盖位置 |
|---|---|
| CHA | T19 brave check |
| WIL | T56 brave check |

### 枚举值（全覆盖）

| 枚举 | 覆盖 |
|---|---|
| bg transition | T9 fade / T12 cut / T15 slow / T1 default |
| char_show transition | T31 dissolve |
| bubble_type（9 种） | T10 ep01（heart/anger/sweat/question/exclaim/idea/music/doom/ellipsis 连发） |
| rarity | T21 uncommon / T34a rare / T34b epic / T34c legendary |
| gate `@end` type | T29a bad_ending / T35 complete / T42 bad_ending / T45 to_be_continued |
| comparison op | T23 >= / T26 <= / T32 == != / T33 > < / T54x-h <（literal-left） |
| compound op | T23 && / T23 \|\| / T52 / T53 |
| signal kind | mark（T20 / T22a / T28a / T58 / 多处）/ int（T20 / T58b / T54c） |
| signal int op | `=`（T58b 初始化）/ `+`（T20 / T58b）/ `-`（T58b） |
| trick_type（6 种） | T16t ep01 (tap) / T55t stress（tap/hold/swipe/shake/swing/tilt 全连发） |

> 位置（left/center/right）已从 spec 删除；引擎运行时从 `gamestate.MC` 派生（MC 左、其他角色右、同屏一人）——本测试集不再有 position 枚举表。

### Step ID tag（覆盖核心 tag）

| tag | 触发 step type | 覆盖位置 |
|---|---|---|
| `dlg` | dialogue | 各剧本 CHARACTER 行 |
| `nar` | narrator | NARRATOR 行 |
| `you` | you | YOU 行 |
| `pau` | pause | T11 / T58a |
| `ch` | choice | T18 / T56 |
| `mg` | minigame | T16 / T55 / T59 |
| `trk` | trick | T16t / T55t |
| `cg` | cg_show | T24 |
| `bg` | bg | 各 SCENE 起 |
| `char` | char_show / bubble | T1 / T10 / T15 / T28 等 |
| `mus` | music / music_stop | T1 / T9 / T27（music_stop） |
| `sfx` | sfx | T12 / T17 (`@sfx crowd`) / T50a |
| `phn` | phone_show / text_message | T5-T7 / T25a / T57 |
| `sig` | signal | T20 / T22a / T58b 等 |
| `aff` | affection | T20 |
| `ach` | achievement | T21 / T34 / T25m1 |
| `btf` | butterfly | T20 / T28 / T25m |
| `ctrl` | if | T23 / T25 / T29 (预告链) / T51-T54 |

---

## 设计原则

1. **对白即清单** —— 每个 `[T##]` 编号直接写进旁白/独白，测试者播放到哪就知道测到哪
2. **Gate 路由封闭** —— 所有 `@next` 指向本测试集内实际存在的 .md 文件；`@end` 当场终态
3. **剧情极简** —— 无情节铺陈，只承载功能点
4. **一次跑通** —— 5 个文件 + 一次 compile 就能回归整个 LS 表面
5. **真实素材** —— 所有 URL 由 OSS mapping 拼接，可在前端播放器直接播出

## 维护

- 加新特性 → 在合适的剧本追加一段，给一个 `[T##]` 编号，补到本 README 的清单 + 覆盖矩阵
- Spec 变更 → `git diff testdata/feature_parade/*_output.json` 人肉审核 golden 是否符合新预期

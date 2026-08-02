# LS `@signal int` — 作者自定义的跨集持久整数变量

> **历史设计记录，不是当前规范。** 当时采用的小写 `snake_case` 命名已被
> Lunaverse Script contract v2 取代；当前规则只看仓库根目录 `LS-SPEC.md`、
> `contract/contract.json` 和 `contract/episode.schema.json`。

> 扩展 `@signal` 指令，新增 `int` kind，作为作者可自由声明、跨集持久的整数计数器。与 `@affection` 并列，但命名自由、不绑定角色。

---

## 1. 背景与动机

### 1.1 当前格局

LS 目前有三类持久数值/状态：

| 机制 | 写入 | 读取 | 命名 |
|------|------|------|------|
| `@affection <char> +N/-N` | 作者可改 | `affection.<char>` | 绑定角色 |
| 引擎管理数值（`san`、`cha`、`hp` 等） | 作者**不可**改 | 裸名（`san <= 20`） | 引擎定义 |
| `@signal mark <event>` | 作者可写（一次性置 true） | 裸名（`EP01_COMPLETE`） | `SCREAMING_SNAKE_CASE` |

### 1.2 缺口

作者需要"**自由命名的跨集整数计数器**"——用于剧情锁场景：

- "被 Easton 拒绝 3 次以上走 bad end"
- "前 5 次选择里至少选了 3 次 brave 才触发隐藏剧情"
- "累计同情弱者超过 4 次解锁好结局"

`@signal mark` 只能布尔，无法计数；`@affection` 绑定角色不合适；引擎数值是只读且命名固定。

### 1.3 设计取向

**最小扩展 + 最大复用**：

- `@signal` 指令已有 `kind` 插槽（spec 明确"kind 词元保留以便未来扩展"），把 `int` 作为第二个 kind 加入
- 读取侧完全复用现有 comparison AST（`left.kind = "value"` + 裸名），parser / AST / 前端 读取路径零修改
- 写入侧新增 3 种形态的子语法

---

## 2. 语法

### 2.1 写入

```
// 赋值（无条件覆盖）
@signal int rejections = 0
@signal int rejections = 5
@signal int rejections = -3         // 支持负数字面量

// 增减
@signal int rejections +1
@signal int rejections -2
```

三种形态共用前缀 `@signal int <name>`，区别只在后缀：

| 后缀 | 语义 |
|------|------|
| `= <int>` | 无条件赋值（每次执行都覆盖当前值） |
| `+<N>` | 当前值 + N |
| `-<N>` | 当前值 - N |

`<int>` / `<N>` 必须是**整数字面量**（不支持变量引用、算术表达式）。`<int>` 可为负（如 `-3`），`<N>` 必须为正整数（负数通过 `-N` 形态表达）。

### 2.2 读取

在 `@if` 条件的 comparison 左值中以**裸名**使用，与引擎管理数值同语法：

```
@if (rejections >= 3) { ... }
@if (rejections == 0) { ... }
@if (rejections >= 3 && affection.easton < 2) { ... }

@gate {
  @if (rejections >= 3): @next main/bad/rejected:01
  @else @if (brave_count >= 3): @next main/route/hidden:01
  @else: @next main:02
}
```

操作符与现有 comparison 完全一致：`>=` `<=` `>` `<` `==` `!=`。

---

## 3. 语义

### 3.1 生命周期

- **跨集持久**：值在整个 playthrough 存活，由引擎持久化
- **与 `affection` / `mark` 同等生命周期**：不随 episode 切换清零，不随 `@choice` 回退而回滚

### 3.2 首次引用

若一个 `int` 变量在任何写入之前就被读/改：

- `@if (rejections >= 3)` 读 → 视为 `0`
- `@signal int rejections +1` 增量 → 从 0 起算，结果为 1
- `@signal int rejections -1` 减量 → 从 0 起算，结果为 -1

无需显式声明。`@signal int rejections = 0` 是"显式初始化"，但不是语法必需。

### 3.3 赋值语义

`=` 形态**无条件覆盖**。如果作者把 `@signal int rejections = 0` 放在 ep01 顶部、玩家通过 remix 重访 ep01，该变量会被重置为 0。这是作者需要意识到的责任——引擎不保护。

### 3.4 命名空间

- `@signal int` 定义的变量与引擎管理数值（`san`、`cha`、`hp`、`xp` 等）**共享**同一裸名命名空间
- 作者不得使用引擎保留名。validator 维护一份保留名单，冲突时报错
- 与 `@signal mark` 事件名**不同空间**（mark 事件走 flag condition，int 变量走 comparison condition）——解析在 `@if` 中靠语法形态区分：`NAME` 是 flag，`NAME <op> N` 是 comparison

### 3.5 命名约定

- **`snake_case` 小写**（如 `rejections`、`times_met_easton`、`brave_count`）
- 与 `affection.<char>` / 引擎数值的小写风格一致
- 不用 `SCREAMING_SNAKE_CASE`——避免视觉上与 signal mark flag 混淆

### 3.6 使用文化（与 `mark` 区分）

| 维度 | `@signal mark` | `@signal int` |
|------|----------------|---------------|
| 类型 | 持久布尔标记 | 持久整数计数器 |
| 写入频率 | **稀有**——只在关键剧情点打 | **自由**——可按需频繁写入 |
| 典型用途 | 一次性关键抉择、隐藏剧情前置条件 | 计数、累计、阈值型剧情锁 |
| 作者诫命 | "必须有人读，不要每集结尾顺手打" | 按业务需要自由使用 |

spec 文档里需要把这两段文化清晰分开——避免新人作者把 `@signal int x +1` 也当作"珍贵事件"而不敢用。

---

## 4. AST / JSON 输出

### 4.1 写入节点

复用 `signal` step type，按 `kind` 分派字段：

```json
// mark（现有，不变）
{"type": "signal", "kind": "mark", "event": "HIGH_HEEL_EP05"}

// int — 赋值
{"type": "signal", "kind": "int", "name": "rejections", "op": "=", "value": 0}

// int — 增
{"type": "signal", "kind": "int", "name": "rejections", "op": "+", "value": 1}

// int — 减
{"type": "signal", "kind": "int", "name": "rejections", "op": "-", "value": 2}
```

**字段说明**：
- `kind`: `"mark"` | `"int"`
- `kind=mark`：携带 `event`
- `kind=int`：携带 `name` / `op` / `value`，其中 `op` ∈ `{"=", "+", "-"}`，`value` 为整数
- 负数字面量通过 `op="="` + 负 `value` 表达（如 `= -3` → `{"op":"=", "value":-3}`）；`+` / `-` 的 `value` 恒为非负整数

### 4.2 读取节点

**零修改**。现有 comparison AST 直接覆盖：

```json
{
  "type": "comparison",
  "left": {"kind": "value", "name": "rejections"},
  "op": ">=",
  "right": 3
}
```

`left.kind = "value"` 已用于引擎管理数值（如 `san`、`cha`），`@signal int` 变量走完全相同的结构。后端按名字查引擎数值表 or 用户 int 表（运行时实现层的事），AST 层不区分。

---

## 5. 实现影响范围

### 5.1 涉及的 Go 包

| 包 | 改动 |
|----|------|
| `internal/token` | 可能需要识别 `=` 作为运算符（当前 parser 已用 `=` 于 CG block 字段等，视现有 token 化层情况） |
| `internal/parser` | `parseSignal` 的 kind 分派新增 `int` 分支；解析 `<name> (=\|+\|-) <int>` |
| `internal/ast` | `SignalNode` 扩展：增加 `Name` / `Op` / `Value` 字段（mark 分支填 `Event`，int 分支填新字段）；或新增 `IntSignalNode`，二选一看实现哪个更干净 |
| `internal/validator` | 新增引擎保留名单检测；写入点的 `<name>` 不得与保留名冲突；`@if` 的裸名 comparison 左值无需额外校验（运行时层处理） |
| `internal/emitter` | `signal` step JSON 输出按 kind 分派字段 |
| `internal/resolver` / `internal/fixer` | 视其是否涉及 signal 处理，可能需要小调整（预计不涉及） |

### 5.2 不需要改的

- **`@if` comparison 的 lexer / parser / AST**：裸名 + 操作符 + 整数字面量的结构已存在
- **前端播放器**：读取路径完全不变；写入路径按 `kind` 分派新增 handler（前端实现层的事，不在解释器范围内）

### 5.3 引擎保留名单（初稿）

validator 应拦截以下名字的 `@signal int <name>` 声明：

```
san, cha, atk, hp, xp, dex, int, str, wis, con
```

具体名单由引擎团队确认。`int` 作为保留名本身就有冲突风险（和 kind 词元重名），validator 报友好错误即可。

---

## 6. 文档更新点

按现有 `LS-SPEC.md` 结构：

1. **4.7 状态变更** — 重写 `@signal` 小节：
   - 增加 kind 对比表：`mark` vs `int`
   - `@signal mark` 子节：保留现有 mark 全部文档（包括"mark 要克制"的文化诫命）
   - **新增 `@signal int` 子节**：语法三形态、语义（持久、auto-init 为 0、赋值无条件覆盖）、命名约定、读取方式示例、"与 mark 的使用文化区别"
2. **4.7 引擎管理的数值段** — 补一句说明：作者可用 `@signal int` 自由定义跨集整数变量，命名空间与引擎数值共享且不可与保留名冲突
3. **4.8 条件类型表** — comparison 行的"左值"说明：补充 `@signal int` 定义的变量也走该路径
4. **JSON 输出节** — 加 `signal kind=int` 三种 op 的示例
5. **附录 B 速查表** — `@signal` 行扩展：
   ```
   @signal mark <event>                  持久布尔标记
   @signal int <name> = <int>            设置整数变量
   @signal int <name> +<N> / -<N>        增减整数变量
   ```

---

## 7. 测试计划

### 7.1 Parser 测试（`internal/parser/parser_test.go`）

- `@signal int x = 0` → SignalNode{Kind:"int", Name:"x", Op:"=", Value:0}
- `@signal int x = -3` → Value:-3
- `@signal int x +1` → Op:"+", Value:1
- `@signal int x -2` → Op:"-", Value:2
- 错误：`@signal int` (缺 name)
- 错误：`@signal int x` (缺运算符)
- 错误：`@signal int x =` (缺值)
- 错误：`@signal int x = abc` (非整数字面量)
- 错误：`@signal int x +-3` / `@signal int x + -3` (+/- 后必须非负整数)
- 错误：`@signal int x * 2` (不支持 `*`)
- 错误：`@signal foo x = 0` (未知 kind)
- 回归：`@signal mark EP01_DONE` 仍正确

### 7.2 Validator 测试（`internal/validator/validator_test.go`）

- `@signal int san = 0` → 报引擎保留名冲突
- `@signal int rejections = 0` → 通过
- （可选）`@signal int` 与 `@signal mark` 同一 event/name 空间冲突检测（若决定严格隔离的话——本 spec 默认不隔离 mark 事件名和 int 变量名，靠命名风格区分）

### 7.3 Emitter / Golden 测试

- 在 `testdata/fixtures/` 加一个小 ep 用到 `@signal int`（如 `rejections +1`、`= 0`、在 gate `@if (rejections >= 3)`），regenerate golden JSON
- golden JSON 含 `{"type":"signal","kind":"int",...}` 步骤
- gate comparison 使用 `left.kind="value", name:"rejections"`

### 7.4 集成 / fixture

- 在 `testdata/` 的 LS 全功能测试脚本里加一段 `@signal int` 用例（赋值 + 增减 + 条件读取），证明端到端 pipeline 正常

---

## 8. 验收标准

- [ ] `LS-SPEC.md` 按 §6 更新
- [ ] Parser 支持三种写入形态 + 错误诊断
- [ ] Validator 拦截引擎保留名冲突
- [ ] Emitter 输出 `signal kind=int` JSON step
- [ ] `@if (name <op> N)` 读取 `@signal int` 定义变量（复用现有路径，不需新代码但要有测试验证）
- [ ] Parser / validator / emitter 单元测试通过
- [ ] Golden fixture 覆盖 `@signal int` 端到端
- [ ] `@signal mark` 现有行为完全不变（回归测试）

---

## 9. 未来扩展留白

本 spec 只引入 `int` kind。未来若需要更多数值类型，可继续在 `@signal` 家族扩展：

- `@signal float`（小数）— 目前剧情机制不需要
- `@signal string`（字符串状态）— 目前剧情机制不需要

保持克制。只有当剧情机制真的需要时再引入新 kind。

# Kling CLI

可灵（Kling）AI 官方命令行工具：图片/视频生成、可复用 Element 主体与动作控制。

- **CLI 形态的 MCP client**：命令与可灵后端 MCP 工具一一对应（`text_to_image`、`query_tasks` …），CLI 只做参数翻译、登录、轮询与上传。
- **跨平台**：macOS / Linux / Windows，仅需 Node.js 18+，无其它依赖。
- **Agent 友好**：所有输出为 JSON，非交互环境自动免提问。配套的 Agent 使用技能（`SKILL.md`）独立托管、单独分发，不随本包发布。

## 安装

可灵分**国内站**与**海外站**，对应两个安装包，端点已各自内置；按账号区域二选一（命令名均为 `kling`）：

```bash
# 国内站（账号登录 klingai.com）
npm i -g @klingai/cli-cn --registry=https://registry.npmjs.org

# 海外站（global）
npm i -g @klingai/cli-global --registry=https://registry.npmjs.org

kling <command>
```

> 要求 Node.js >= 18。两个包发布到 npm 官方 registry。下文示例统一用 `kling`。

## 升级

```bash
# 升级到最新（按已装区域包替换包名；勿用 npm update -g，可能不会跳大版本）
npm i -g @klingai/cli-cn@latest --registry=https://registry.npmjs.org

kling --version              # 查看当前版本
```

## 快速开始

```bash
# 1. 登录（端点已内置，开箱即用；打开浏览器完成 OAuth 授权，凭据保存在本地，不会打印）
kling login

# 2. 能力发现（身份 + 各生成命令的可用模型与参数规格，新会话建议先调）
kling who_am_i

# 3. 从 who_am_i 的 text_to_image 清单选模型替换 MODEL；--poll 60 表示最多等待 60 秒直接返回结果
kling text_to_image --model MODEL "一只柴犬坐在咖啡馆窗边" --poll 60

# 4. 或者先提交、再用返回的 generationId 查询
kling text_to_image --model MODEL "一只柴犬坐在咖啡馆窗边"
kling query_tasks <generationId> --poll
```

生成成功后，从输出 JSON 的 `works[].url` 取图片/视频地址（无水印版本为 `works[].urlWithoutWatermark`）。

## 命令一览

生成与查询命令和可灵后端 MCP 工具同名（snake_case），无别名：

| # | 命令名 | 分组 | 同步性 | 触达下游 | 一句话说明 |
|---|--------|------|--------|----------|------------|
| 1 | `--help`（或不带参数） | 能力发现 | 同步 | 否 | 打印全部命令与用法；`<command> --help` 查看单命令参数（登录后读取实时声明，离线回退本地用法） |
| 2 | `who_am_i` | 能力发现 | 同步 | 否 | 返回当前用户身份 + 每个生成命令的可用模型与参数规格；**首次调用先打它** |
| 3 | `text_to_image --model MODEL <prompt>` | 生成 | **异步** | 是 | 文生图，返回 `generationId`，需轮询 `query_tasks`（或加 `--poll` 一步出结果） |
| 4 | `image_to_image --model MODEL [options] [prompt]` | 生成 | **异步** | 是 | 参考图 + prompt 生新图，返回 `generationId`（本地图片自动上传） |
| 5 | `text_to_video --model MODEL <prompt>` | 生成 | **异步** | 是 | 文生视频，返回 `generationId`，需轮询 `query_tasks` |
| 6 | `image_to_video --model MODEL [options] [prompt]` | 生成 | **异步** | 是 | 图生视频（让图动起来），返回 `generationId` |
| 7 | `omni_ref_video --model MODEL <prompt>` | 生成 | **异步** | 是 | 全能参考混排（图/视频/音频/主体），返回 `generationId` |
| 8 | `query_tasks <generationId>` | 任务查询 | 同步 | 是 | 按 `generationId` 查询生成状态与最终资源 URL（`works[].url`） |
| 9 | `file_upload <path>` | 文件上传 | 同步 | 是 | 两步式上传（申请一次性票据 + 上传文件字节），返回公网 URL |
| 10 | `element_create` | 主体素材 | 同步 | 是 | 从图片组或视频创建可复用 Element |
| 11 | `element_list` / `element_get` | 主体素材 | 同步 | 是 | 列出 Element 或按 id 获取完整详情 |
| 12 | `element_update` / `element_delete` | 主体素材 | 同步 | 是 | 按字段更新或删除 Element；图片主图由 CLI 自动保留 |
| 13 | `motion_library_list` | 动作素材 | 同步 | 是 | 列出已保存动作素材 |
| 14 | `motion_control` | 生成 | **异步** | 是 | 用主体图 + 动作视频或 motionId 生成视频 |
| 15 | `feedback` | 反馈 | 同步 | 是 | 上报卡住、计费异常或意外结果 |
| 16 | `account` | 商业化 | 同步 | 是 | 会员类型 + 可用灵感值 |
| 17 | `tool_list` | 能力发现 | 同步 | 否 | 列出后端 MCP server 当前暴露的工具（MCP `tools/list`） |
| 18 | `login` | 鉴权 | 同步 | 否（仅 OAuth 服务） | 浏览器 OAuth 登录 |
| 19 | `logout` | 鉴权 | 同步 | 是 | 调用 MCP `logout` 注销服务端授权，并清除本地登录态，以便重新授权或切换账号 |

切换账号必须按顺序执行 `kling logout` → `kling login` → `kling who_am_i`；`logout` 或 `login` 任一步失败都立即停止。

> 端点已内置（`src/config.ts` 的 `DEFAULT_BASE_URL`，端点唯一来源，发布时定稿），开箱即用；**无外部覆盖口子**（无 `KLING_BASE_URL`、无 `.env`），换端点须改该常量后重新发布。凭据按端点 host 分段保存，多端点可共存。

选项（`--model` 与 `--poll` 仅用于支持它们的命令，其余为全局 flag）：

| Flag | 作用 |
|------|------|
| `--model <名称>` | 指定模型（生成命令必填；可用模型见 `who_am_i`） |
| `--skill-name <n>` / `--skill-version <v>` | 可选遥测：标识调用方 skill（随请求上报服务端；`login` 时还决定 DCR `client_name` 后缀 `_skill`/`_cli`，不影响功能） |
| `--poll [N]` | 提交后原地轮询最多 N 秒（裸 flag 默认 60，0 关闭） |
| `--quiet` / `-q` | 紧凑单行 JSON 输出（便于管道处理） |
| `--help` / `-h` | 查看帮助（顶层或单命令） |
| `--version` / `-v` | 查看版本 |

任意命令加 `--help` 可查看该命令的参数说明，如 `kling image_to_video --help`。对 MCP-backed 命令，生成命令 help 会读取实时 `who_am_i` 模型参数与槽位，其他命令读取 `tools/list`（工具说明 + inputSchema），离线或未登录时回退到本地静态用法。

## 模型与参数：以 `who_am_i` 为准

可用模型、每个参数的必填性 / 默认值 / 合法取值**全部由服务端声明**，运行 `kling who_am_i` 即可查看。生成命令必须显式传 `--model <名称>`（旧的 `--omni` / `--flash` 简写已移除）；其他未传参数由服务端回填默认值。传了未声明的参数或非法取值，服务端会在**扣费前**报错并列出问题项。

## 常用示例

### 文生图 `text_to_image`

```bash
kling text_to_image --model kling-image-v3_0 "赛博朋克城市夜景" \
  --aspectRatio 16:9 --imgResolution 2k --imageCount 4 --poll 120

# 指定模型（模型名以 who_am_i 实时清单为准）
kling text_to_image --model kling-image-v3_0 "水彩风格的富士山" --poll
```

### 参考图生图 `image_to_image`

```bash
# --image 可传公网 URL 或本地路径（本地文件自动上传），可重复
kling image_to_image --model kling-image-v3_0 --image ./cat.jpg --image ./style.png \
  "图片1 的猫换成 图片2 的画风" --poll 120
```

### 文生视频 `text_to_video`

```bash
kling text_to_video --model kling-video-v4_0 "无人机视角掠过雪山之巅" \
  --duration 10 --aspectRatio 16:9 --poll 300
```

### 图生视频 `image_to_video`

```bash
kling image_to_video --model kling-video-v4_0 --image ./first.jpg --tailImage ./last.jpg \
  "镜头缓缓推近" --duration 6 --poll 300

# Flash 仅首帧，不支持 --tailImage
kling image_to_video --model kling-video-v4_0_flash --image ./first.jpg --prompt "" --poll 300
```

`--image` 与 `--tailImage` 都按**名字**填入模型在 `who_am_i` 里声明的槽位（`--image` 依次填非尾帧槽位，
`--tailImage` 固定填 `tail_image`），所以只给 `--tailImage` 就是一个合法的仅尾帧任务。

关键帧要落在首帧以外的位置（仅尾帧、仅中间帧、首+中+尾……）时，用 `--input <槽位名>=<url|path>`
按槽位逐个指定。槽位名由所选模型在 `who_am_i` 里声明，`--input` 不能与 `--image` / `--tailImage` 混用：

```bash
kling who_am_i                                 # 先看该模型声明了哪些输入槽位
kling image_to_video --model kling-video-v4_0 \
  --input tail_image=./last.png "从这一帧收尾" --poll 300

# 标准 V4：首帧、中间帧、尾帧可自由组合，图片总数最多 10 张
kling image_to_video --model kling-video-v4_0 \
  --input first_image=./first.jpg --input keyframe_1=./middle.jpg \
  --input tail_image=./last.jpg --prompt "" --poll 300

# 各帧声明可选时，CLI 不拦截无图请求；组合是否接受由服务端校验
# 普通纯文本生成使用 text_to_video
kling text_to_video --model kling-video-v4_0 "雨夜霓虹街道推镜" --poll 300
```

素材数超过模型声明的槽位数时（如给仅首帧的 Flash 传两张图），CLI 在上传前就报错，不会白传文件。

标准 V4 Preview 的三个入口均使用 `--model kling-video-v4_0`。当前声明支持 3–30 秒、720p/1080p（取决于账号权限）；Flash 为 3–20 秒、720p，实际以 `who_am_i` 为准。
标准版的 `first_image`、`tail_image`、`keyframe_1..10` 均可选，但合计最多 10 张；CLI 在上传前按 `combinedItemCap` 校验。有首帧时不主动传 `--aspectRatio`，跟随首帧；关键帧入口不接受 `auto`。

### 全能参考 `omni_ref_video`

```bash
kling omni_ref_video --model kling-video-v4_0_flash --image ./ref.jpg --video ./clip.mp4 \
  "按参考图和视频混排出新镜头" --poll 300

# 标准 V4 混参考；保留参考视频原声时关闭新生成音频
kling omni_ref_video --model kling-video-v4_0 --image ./ref.jpg --video ./clip.mp4 \
  --keepOriginalSound true --enableAudio false "参考视频1的运镜，保持图片1的角色外观" --poll 300

# 纯文本示例：无必填素材时，仍需满足模型的参数约束
kling omni_ref_video --model kling-video-v3_0_omni --aspectRatio 16:9 "海边日落的长镜头" --poll 300

# 绑定已有 Element；把 ELEMENT_ID 和 type 换成 element_get 返回的值
kling element_get ELEMENT_ID
kling omni_ref_video --model kling-video-v4_0 \
  --elements '[{"id":"ELEMENT_ID","bindName":"Alice","type":"image"}]' \
  --aspectRatio 16:9 "<<<ELEMENT_ID>>> 在海边散步" --poll 300
```

用 `element_list` 查找已有主体。`--elements` 接收 JSON 数组字符串，每项为 `{id, bindName, type}`；提示词用 `<<<id>>>` 引用同一主体 ID。主体可与 `--image`、`--video` 混用。只传主体时，若模型的 `auto` 比例要求图片/视频输入，应显式指定比例。完整格式和各模型限制见 `kling omni_ref_video --help`。

V4 全能参考按秒计费，输入视频时长也计入总计费时长。当前声明最多 10 张图、5 段视频、7 个主体（其中视频主体最多 3 个），素材/主体合计最多 15 个。独立音频按实时 `audio_N` 槽位判断：新声明中标准 4.0 支持最多 3 段音频，Flash 未声明；若当前连接未声明音频，仍不能传 `--audio`。CLI 自动上传本地音频，并按声明把音频计入合计上限。`enable_audio` 与 `keepOriginalSound` 不能同时为 true。提交前仍以 `who_am_i` 核实限制，主体类型由 `element_get` 确认。

### 任务查询与文件上传

```bash
kling query_tasks <generationId>            # 查询一次
kling query_tasks <generationId> --poll 120 # 轮询直到出结果（最多 120 秒）
kling file_upload ./photo.jpg               # 两步式上传，返回公网 URL
kling account                               # 账户身份 + 会员类型
```

### Element 与动作控制

```bash
kling element_create --name "Alice" --description "红发侦探" --tag 角色 \
  --cover ./front.png --secondary ./side.png
kling element_list
kling element_get <elementId>
kling element_update <elementId> --description "新的描述" # 其他字段及原主图自动保留

kling motion_library_list
kling motion_control --model <model> --image ./subject.png --motionId <id> \
  --motionDirection image_direction "跟随参考动作，保持主体外观" --poll 300
```

## 输出与退出码

- 默认输出格式化 JSON；`--quiet` 输出紧凑单行 JSON。进度等提示信息写到 stderr，不污染 stdout。
- 退出码：`0` 成功；`1` 失败（参数错误 / 未登录 / 服务端报错等）；`130` 用户取消（Ctrl+C）。
- 提交返回 `generationId`（轮询凭据）与 `creditsConsumed`（本次消耗灵感值）；生成结果在 `query_tasks` 的 `works[]` 中，`works[].url` 即产物地址（无水印为 `works[].urlWithoutWatermark`）。

## 在 AI Agent 中使用

本包是纯 CLI，**不含** Agent 使用技能。配套的 `kling-cli` 使用技能（Agent 行为规范：意图路由 / 轮询纪律 / 计费纪律 + 接口示例）**独立托管、单独分发**——让 Agent 安装该技能并按其中指引调用已全局安装的 `kling` 命令即可。

真实终端中的 `element_update` 会先引导补齐缺失的 `elementId`；`motion_control` 会在上传前引导补齐缺失的模型、素材来源和服务端声明的必填生成参数。非交互环境（Agent / 管道 / CI）下 CLI 不会停下来提问：缺参数或未登录时直接报错并以非零码退出。也可设置 `KLING_NONINTERACTIVE=1` 强制关闭交互。

## 注意事项

- **每次生成都会消耗灵感值**，提交前请确认参数；失败/超时请先查询任务状态，不要盲目重试。
- 登录凭据保存在本地文件中，CLI 任何时候都不会打印 token / 密钥；`logout` 可清除。
- 命令没有别名：一个命令一个名字，与 MCP 工具同名（snake_case）。

## License

详见包内 LICENSE 文件。

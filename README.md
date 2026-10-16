# glm-statusline

Claude Code 底部状态栏插件：显示智谱 GLM / MiniMax 额度、DeepSeek 余额、会话累计 token 和估算生成速度。

支持 Windows、Linux 和 macOS；纯 Node.js 实现，无原生扩展。

```
GLM-4.6 | glm-statusline | main | ctx 87% | PRO 5h 62% (2h12m) · 周 88% (3d4h) · ¥46.2
```

- `5h 62%` — Coding Plan 5 小时窗口**剩余**百分比，`(2h12m)` 为重置倒计时
- `周 88%` — 每周窗口剩余（老套餐无此项，自动隐藏）
- `¥46.2` — 按量付费账户可用余额（仅国内版；套餐用户可关闭）
- `ctx 87%` — 上下文**剩余**比例；`ctx ~87%` 为历史估算，`ctx --` 表示暂无可靠数据
- 剩余 ≤15% 红色、≤40% 黄色，其余绿色
- 额度查询结果缓存 60 秒；缓存未命中时等待接口，超时默认 5 秒
- 同一账号并发刷新时只发起一组请求，其他调用显示有效缓存或「GLM 刷新中」
- 查询失败时，有效期内的旧数据标记「缓存」；超过兜底期限后停止显示

默认启用会话用量与估算生成速度，显示示例（配置见下方）：

```text
deepseek-flash[1m] | glm-statusline | ctx ~82% | tok 11.9M ↑104.7k ↓94.5k ⚡11.7M | 150 tok/s | ¥97.81
```

- `tok`：整个主会话的累计用量，`↑` 为输入，`↓` 为输出，`⚡` 为缓存读取与创建之和。
- `speed`：最近 5 次响应的估算生成速度，可用 `speedSamples` 调整到 1–20。
- `deepseek`：DeepSeek 可用余额，支持人民币和美元；断网时可显示带「缓存」标记的旧余额。
- `minimax`：MiniMax M Plan 的 5 小时及每周剩余额度，支持国内与国际平台。
- 深色终端按 `COLORFGBG` 的背景色选择亮色；支持 256 色时使用更清晰的蓝、紫、红色。

## 版本更新

| 版本 | 主要变化 | 哪些用户建议升级 |
|---|---|---|
| **1.0.9** · 2026-10-16 | 默认显示 token 和速度；首次升级备份并重置配置；修复 MiniMax 国内域名识别，统一精简显示 | 所有用户；升级需运行 `--setup`，原状态栏自定义配置会先备份再重置 |
| **1.0.8** · 2026-10-16 | 自动识别 GLM / DeepSeek / MiniMax，新增会话 token 和估算速度，多服务商并发查询 | 使用多家服务商或关注会话用量的用户；已有配置需将服务商分段改为 `auto` |
| **1.0.7** · 2026-10-14 | 新安装默认自动选择中英文标签和状态提示，可固定为中文或英文 | 希望跟随系统语言的用户；已有配置需将 `lang` 改为 `auto` |
| **1.0.6** · 2026-10-14 | 补齐历史更新日志，npm 首页展示版本摘要，发布后自动生成 GitHub Release | 文档与发布流程更新；状态栏功能与 1.0.5 相同，已有 1.0.5 用户可按需升级 |
| **1.0.5** · 2026-10-14 | 修复 Windows 无 Git Bash 时 PowerShell 无法启动状态栏；支持带空格路径 | Windows 状态栏不显示的用户，升级后必须重新运行 `--setup` |
| **1.0.4** · 2026-10-12 | 支持 HTTP / HTTPS 代理、代理认证和 `NO_PROXY` | 需要经代理查询额度或余额的用户 |
| **1.0.3** · 2026-10-11 | 修复恢复会话后的上下文比例；估算值标记 `~`，未知值显示 `--` | 使用恢复会话、关注上下文剩余比例的用户 |

查看[完整更新日志（含早期版本）](https://github.com/wenxingyu/glm-statusline/blob/main/CHANGELOG.md)
或 [GitHub Releases](https://github.com/wenxingyu/glm-statusline/releases)。

**升级并应用修复：**

```bash
npx --yes @wenxingyu/glm-statusline@latest --setup
```

Windows PowerShell 可将 `npx` 换成 `npx.cmd`。随后重启 Claude Code 或开启新会话。
本次升级的 `--setup` 会先备份旧状态栏配置，再整体替换为新默认配置，自动启用 `tok`、`speed`、`auto`。
替换仅执行一次，此后重复安装保留用户修改；仅升级全局 npm 包不会更新已部署的运行文件。

## 安装

需要 Node.js 18.17 或更高版本及 npm，无第三方运行依赖。从源码安装时才需要 Git。

| 系统 | 安装终端 | 默认用户配置 |
|---|---|---|
| Windows | PowerShell、CMD 或 Git Bash | `%USERPROFILE%\.claude\glm-statusline.json` |
| Linux | Bash 等终端 | `~/.claude/glm-statusline.json` |
| macOS | Zsh 或 Bash | `~/.claude/glm-statusline.json` |

下方安装命令三端通用。Windows PowerShell 若限制 `npm.ps1` 执行，可使用
`npm.cmd` / `npx.cmd` / `glm-statusline.cmd`。使用 WSL 时，请在 WSL 内安装 Node.js
并运行安装命令，使配置和运行文件位于 WSL 用户目录。

包公开发布到 npm，无需 npm 或 GitHub 账号即可安装。

### 方式一：npx 一键配置（推荐）

```bash
npx --yes @wenxingyu/glm-statusline@latest --setup
```

### 方式二：npm 全局安装

```bash
npm install -g @wenxingyu/glm-statusline@latest
glm-statusline --setup
```

请使用完整包名 `@wenxingyu/glm-statusline`，安装后的命令名为 `glm-statusline`。
若镜像源尚未同步新版本，可在 npm/npx 命令中添加 `--registry=https://registry.npmjs.org/`。

`--setup` 会：

1. 将运行文件保存到 `~/.claude/glm-statusline/`，状态栏运行时不依赖 npx 缓存或网络下载。
2. 创建用户配置 `~/.claude/glm-statusline.json`；首次迁移已有配置时先生成
   `glm-statusline.json.backup-时间戳-唯一标识`，再整体替换为默认配置。
3. 更新 `~/.claude/settings.json` 中的 `statusLine`，保留其他设置。
   如需替换已有设置，会先生成 `settings.json.backup-*` 备份。

这次迁移会重置状态栏的分段、语言、服务商参数、缓存时间等自定义选项，
但保留 Claude `settings.json` 中的 API Key、代理和权限等其他设置。
旧状态栏配置按原始内容完整备份，安装完成会打印备份路径；备份失败时中止替换。
如需恢复，将该备份复制回 `~/.claude/glm-statusline.json` 即可。
迁移记录保存于 `~/.claude/glm-statusline/setup-state.json`，后续重复运行 `--setup`
保留用户修改及手动恢复的配置，无需修改该记录。

升级时重新执行上方带 `@latest` 的安装命令，再运行 `--setup` 更新固定目录中的运行文件。
全局包本身升级不会自动覆盖已部署的运行文件。Linux/macOS 使用 Node.js 绝对路径，
若其安装路径发生变化，请重新运行 `--setup`；Windows 使用 `PATH` 中的 `node`。

### 从源码运行

```bash
git clone https://github.com/wenxingyu/glm-statusline.git
cd glm-statusline
node statusline.mjs --setup
```

重启 Claude Code（或开新会话）即可生效。默认根据 `ANTHROPIC_BASE_URL` 自动识别
GLM、DeepSeek 或 MiniMax，复用对应的 Claude Code API Key，也支持各家的专用 Key。

### Windows 状态栏不显示

Claude Code 在 Windows 上有 Git Bash 时使用 Git Bash，没有时使用 PowerShell
（见[官方说明](https://code.claude.com/docs/en/statusline#windows-configuration)）。
旧版安装器生成的 `"C:/Program Files/nodejs/node.exe" "脚本路径"` 不能在 PowerShell
中直接执行，因此即使手动运行脚本正常，状态栏也可能完全不显示。

当前安装器在 Windows 上生成以下形式，兼容 PowerShell、CMD 和 Git Bash：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/你的用户名/.claude/glm-statusline/statusline.mjs\""
  }
}
```

脚本路径的引号需要保留，以支持带空格的用户目录；路径使用正斜杠。
旧配置可重新运行修复后的 `--setup` 自动更新并备份，也可按上例仅修改 `statusLine.command`。
请确认启动 Claude Code 的终端中 `node --version` 可用；若刚安装或修改 Node.js 的 `PATH`，
关闭并重新打开终端，再启动 Claude Code。

## 配置

编辑 `~/.claude/glm-statusline.json`。配置优先级为：
`GLM_STATUSLINE_CONFIG` 指定的文件 → 用户配置 → 包内 `config.json` → 内置默认值。
仅在文件不存在时继续查找；文件存在但 JSON 无效时使用内置默认值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `segments` | `["model","dir","git","ctx","tok","speed","auto"]` | 分段及顺序；`tok` 会话用量、`speed` 估算生成速度默认启用；`auto` 按接口域名自动选择服务商，也可使用 `glm`、`deepseek`、`minimax` 固定服务商 |
| `lang` | `auto` | 自动选择标签和状态提示语言；`zh` 固定中文（周），`en` 固定英文（wk） |
| `glm.platform` | `auto` | `cn`（open.bigmodel.cn）/ `en`（api.z.ai）/ `auto`（按 `ANTHROPIC_BASE_URL` 判断） |
| `glm.showBalance` | `true` | 是否查询并显示按量付费余额 |
| `glm.showLevel` | `true` | 是否显示套餐等级（LITE/PRO/MAX） |
| `cacheTtlSeconds` | `60` | 额度查询缓存时间 |
| `staleSeconds` | `1800` | 查询失败时，旧数据距最后成功查询的最大秒数；`0` 禁用失败兜底 |
| `timeoutMs` | `5000` | 单次请求超时 |
| `contextLimit` | `0` | 上下文窗口大小，`0` = 优先使用 Claude Code 上报值，缺失时按模型自动（200k / 1M） |
| `speedSamples` | `5` | 速度使用的最近响应数，范围 1–20，取整数 |
| `minimax.platform` | `auto` | `cn` 国内 / `en` 国际 / `auto` 按 `ANTHROPIC_BASE_URL` 识别，未识别时使用国内平台 |
| `minimax.model` | `auto` | 额度池名称；自动优先选择 `general`，仅有一项时选该项；多项且无 `general` 时需显式填写接口的 `model_name` |
| `minimax.level` | `auto` | `go` / `explore` / `build` 手动指定官方档位名称；`auto` 不猜测，当前额度接口未提供档位时隐藏 |
| `minimax.showLevel` | `true` | 是否显示已配置的 MiniMax 档位名称 |

### 自动识别服务商（默认）

```json
{
  "segments": ["model", "dir", "git", "ctx", "tok", "speed", "auto"]
}
```

`auto` 每次运行根据 `ANTHROPIC_BASE_URL` 的主机名选择额度或余额分段：

| 接口主机名 | 自动显示 |
|---|---|
| `bigmodel.cn`、`z.ai` 及其子域 | GLM 额度及可选余额 |
| `api.deepseek.com` | DeepSeek 余额 |
| `minimaxi.com`、`minimax.cn`、`minimax.io`、`minimax.chat` 及其子域 | MiniMax 额度 |

识别、通用 Key 和国内/国际平台选择使用同一来源规则：Claude `settings.json` 的
`env` 中存在通用 Key 时优先使用该来源的 URL，否则优先使用进程环境的 URL；
该来源未设置 URL 时再读取另一来源。专用 Key 仍按进程环境优先读取。

**URL 缺失、无效或不属于这三家时，自动隐藏该分段，不发起额度/余额请求**，
其他分段照常显示。不会根据模型名称、Key 字符串或已有专用 Key 猜测服务商。
设置 `GLM_STATUSLINE_DEBUG=1` 可在 stderr 查看跳过原因；手动运行 `--query`
且没有可查询的服务商时，会给出原因并以非零状态退出。

使用自定义网关时，可手动配置 `glm`、`deepseek` 或 `minimax` 分段及对应专用 Key，
查询仍使用该服务商的官方接口。`auto` 可与手动分段并用，解析后相同服务商只保留首次出现的位置，
只查询和显示一次。`--demo` 中的 `auto` 固定展示 GLM 假数据。

新安装默认启用 `tok`、`speed` 和 `auto`；不需要会话用量或速度时，可移除对应分段。
本次升级运行 `--setup` 时会备份并替换旧状态栏配置，自动启用上述默认显示；
此后可自由调整分段，重复安装保留调整后的配置。

### MiniMax

在用户配置中添加 `minimax` 段：

```json
{
  "segments": ["model", "dir", "ctx", "tok", "speed", "minimax"],
  "minimax": { "platform": "auto", "model": "auto" },
  "speedSamples": 5
}
```

显示示例：`MiniMax 5h 62% (2h12m) · 周 88% (3d4h)`。
档位名称使用最新官方 [M Plan](https://platform.minimax.cn/docs/m-plan/intro) 的
Go / Explore / Build，不区分极速版。
[官方 CLI 的额度响应定义](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)
没有档位字段，官方也没有公布旧 `total_count` 数值与新档位的固定映射，因此默认不推断档位。
如果需要显示，可按自己的订阅设置 `"minimax": { "level": "go" }`，
单家显示为 `Go 5h 62% · 周 88%`；`minimax.showLevel: false` 可关闭档位显示。
手动配置只改变档位标签，不改变查询账号、额度池或百分比。
`--query` 的 `level` 为手动配置的档位，默认 `null`；旧缓存中的推断档位会被忽略。

额度和余额默认精简显示：单家服务商时，GLM 显示 `PRO · 5h 62% · 周 88%`，
MiniMax 有已配置的档位时显示 `Go 5h 62% · 周 88%`，DeepSeek 显示 `¥97.81`。
同时启用多家时自动加上 `GLM`、`MiniMax`、`DeepSeek` 名称，仍按配置顺序显示。
MiniMax 没有显示档位时保留 `MiniMax` 名称。未配置 Key、查询失败等状态始终保留服务商名。
服务商数量在 `auto` 解析并去重后计算，`auto` 与同一家手动分段并用不会重复显示或增加前缀。

将订阅 Key 放入进程环境或 Claude `settings.json` 的
`env.MINIMAX_API_KEY`（进程环境优先）。也可复用现有 `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY`，其 `ANTHROPIC_BASE_URL` 必须是 MiniMax 域名：
`minimaxi.com` / `minimax.cn` / `minimax.io` / 旧 `minimax.chat` 及其子域；其他服务商的 Key 会提示不匹配。
国际平台 URL（例如 `https://api.minimax.io/anthropic`）自动选择 `en`，
国内 URL（例如 `https://api.minimaxi.com/anthropic` 或 `https://api.minimax.cn/anthropic`）选择 `cn`。
仅设置专用 Key 而没有 MiniMax base URL 时，国际账号请显式配置 `"platform": "en"`。

本段查询 MiniMax 官方额度接口（参见 [M Plan 用量说明](https://platform.minimax.cn/docs/m-plan/usage-rules)），
显示套餐剩余比例与重置倒计时，不包含按量付费账户的现金余额。
优先使用 `general` 额度池，不将多个模型的共享额度相加。剩余比例读取
`current_interval_remaining_percent` / `current_weekly_remaining_percent`；
只有计数字段、缺少有效百分比时提示查询失败，避免误读不同接口的 `usage_count` 语义。
响应字段参考[官方仓库中的原始响应报告](https://github.com/MiniMax-AI/MiniMax-M2.7/issues/48)，
未使用真实账号验证本地接入。`remains_time` 仅用于重置倒计时，不作为额度比例。
缓存、重试间隔、超时及代理复用现有配置，缓存按平台、账号和额度池分别隔离。
可同时启用 `glm`、`deepseek`、`minimax`，分别配置各自专用 Key。

### DeepSeek、会话用量与生成速度

在用户配置中启用所需分段，例如：

```json
{
  "segments": ["model", "dir", "ctx", "tok", "speed", "deepseek"],
  "lang": "auto",
  "speedSamples": 5
}
```

`glm` 始终查询智谱，`deepseek` 始终查询 DeepSeek。各自优先读取进程环境或
Claude settings.env 中的 `GLM_API_KEY` / `DEEPSEEK_API_KEY`，进程环境优先。
也可复用 Claude 的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`：根据对应
`ANTHROPIC_BASE_URL` 的主机名判定服务商（DeepSeek 为 `api.deepseek.com`，
智谱为 `bigmodel.cn` / `z.ai` 及其子域）。服务商不匹配会直接提示，跳过请求。
自定义网关无法识别服务商时，请显式设置对应的专用 Key；仅凭 Key 字符串无法可靠识别服务商。
未设置 base URL 时沿用旧版 GLM Key 读取方式。两个服务商可以同时显示，各用自己的专用 Key。
`--query` 查询配置中启用的服务商（包括 `auto` 识别结果）；只有一项时直接返回该项 JSON，多项时按段名返回对象。

会话用量从 stdin 的 `transcript_path` 读取 JSONL，忽略子代理记录，同一 `message.id`
只累计一次；后续 usage 增长只补差额。缺少 message ID 时使用记录 UUID 去重。
总量包含输入、输出、缓存读取与缓存创建，不是当前上下文大小，`/compact` 不清零。
缺少 transcript 或有效用量时显示 `tok --`。不包含其他 transcript 文件中的用量。

首次扫描按字节增量读取，单次最多 32 MiB，每约 1 MiB 保存断点；下次调用继续。
扫描未完成时总量前标 `~`，未以换行结束的记录等待写完再计入。超过 8 MiB 的单行会跳过。
缓存保存偏移、累计值、响应 ID 哈希及最近 20 个速度样本，不保存消息内容；
写入使用原子替换和进程锁，支持文件截断、替换及损坏缓存后的重建。

速度样本使用“响应首条记录时间 − 此前主会话最大时间戳”估算耗时，
展示最近 `speedSamples` 个有效样本的总输出 token / 总秒数，避免直接平均单次速度。
该时间间隔可能包含网络、工具等待或用户停顿，属于估算吞吐量，不能视为精确的模型解码速度。
没有可靠时间戳或有效输出时显示 `-- tok/s`。只启用 `tok` / `speed` 中任意一项时才扫描累计用量。

深色背景由 `COLORFGBG` 最后一项识别；256 色能力由 `TERM` / `COLORTERM` 判断。
深色终端分别使用蓝 75、紫 177、红 203；无 256 色时退回亮色 16 色，浅色或未知背景使用原标准色。
未设置 `COLORFGBG` 的终端不会自动推断深浅，可在终端环境中设置（例如深色为 `15;0`）。

`lang: "auto"` 优先读取运行环境中有效的 `LC_ALL`、`LC_MESSAGES`、`LANG`，
没有有效值时使用 Node.js `Intl` 提供的系统默认区域语言。中文区域（包括简体、繁体）使用中文，
其他语言、`C` / `POSIX` 区域或识别失败时使用英文。周额度以及缓存、刷新中、查询失败等状态提示一起切换。
这里跟随的是进程可见的区域语言，不读取 Claude Code 的界面语言设置。
修改系统或终端语言后，请重新打开终端并启动 Claude Code，使新的区域设置传入状态栏进程。

新安装和本次配置迁移默认使用 `auto`。原有的 `"lang": "zh"` 或 `"lang": "en"` 会随旧配置备份；
迁移后仍可在 `~/.claude/glm-statusline.json` 中手动指定语言，后续重复安装保留该设置。
显式指定 `zh` / `en` 时不受系统或终端语言影响。

可以用环境变量 `GLM_STATUSLINE_CONFIG` 指定其他配置文件。字段类型或范围无效时，
该字段使用默认值；`segments` 中的未知项会被忽略，重复项去重，空数组表示不显示任何分段。
`timeoutMs` 必须为正数；缓存时间与上下文窗口必须为非负数。

上下文优先使用 Claude Code 的 `context_window.used_percentage` / `remaining_percentage`，
其次由 `current_usage` 的输入与缓存 token 计算，不计输出 token；显式设置 `contextLimit` 时按该窗口重算。
恢复会话时，当前进程尚未收到 API 响应，实时用量可能为 `null`，此时从 transcript 尾部最近的主会话
assistant 用量估算，并以 `~` 标记。最多检查尾部 4 MiB；没有可靠记录或遇到 `/compact` 边界时显示 `ctx --`，
不把未知数据当作 0%。历史记录不代表精确的实时用量，收到新的 API 响应后自动切换回实时值。
字段含义见 [Claude Code 官方文档](https://code.claude.com/docs/en/statusline#context-window-fields)。

### 代理

套餐和余额查询支持 HTTP / HTTPS 代理（CONNECT 隧道），无需额外依赖，兼容 Node.js 18.17。
代理变量可以设置在进程环境或 `~/.claude/settings.json` 的 `env` 中，状态栏与 `--query` 均会读取：

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:7890",
    "NO_PROXY": "localhost,127.0.0.1"
  }
}
```

在已有 `env` 对象中添加这些字段即可。HTTPS 接口优先使用 `HTTPS_PROXY`，未设置时依次使用
`HTTP_PROXY`、`ALL_PROXY`；支持对应小写变量，同一来源中小写优先。进程环境覆盖配置文件中的同名变量。
代理地址支持 `http://`、`https://`，以及 `http://用户名:密码@主机:端口` 的 Basic 认证；
用户名或密码中的特殊字符需要 URL 编码。使用 SOCKS 代理时，请填写代理软件提供的 HTTP 或 mixed 端口。

`NO_PROXY` 为逗号或空白分隔的直连列表：支持精确主机名、IP、`.bigmodel.cn` / `*.bigmodel.cn`
域名及其子域、`主机:端口` 和 `*`（全部直连）。例如设置 `NO_PROXY=.bigmodel.cn` 可让国内接口直连。
仅开启系统代理而未设置上述变量时，脚本不会自动读取系统代理。`timeoutMs` 覆盖代理连接、TLS 握手及响应读取。

修改代码或升级包后，需要重新运行 `--setup` 更新已部署的运行文件。

## 调试

```bash
glm-statusline --help     # 查看命令选项
glm-statusline --version  # 查看版本
glm-statusline --query    # 真实查询一次，打印解析后的额度 JSON（强制绕过缓存）
glm-statusline --demo     # 用假数据预览状态栏样式
echo '{"model":{"display_name":"GLM-4.6"}}' | glm-statusline
```

上述命令适用于 npm 全局安装。仅使用 npx 配置时，可以运行：

```bash
npx --yes @wenxingyu/glm-statusline@latest --demo
```

排错时设 `GLM_STATUSLINE_DEBUG=1` 可看完整报错。

## 测试

```bash
npm test
npm run test:install
npm pack --dry-run
```

测试使用模拟接口和独立临时目录，覆盖缓存隔离、过期兜底、余额开关、异常数据、
配置校验、深层目录分支查找、多进程并发刷新和自动安装，不需要真实 API Key。
代理测试使用本地 HTTP / HTTPS 代理与 TLS 模拟接口，覆盖代理认证、NO_PROXY、
证书域名校验、重定向、各阶段超时，以及安装后的代理配置读取。

GitHub Actions 在 Windows、Ubuntu 和 macOS 上分别使用 Node.js 18.17.0 与 24
运行回归测试和安装测试。安装测试实际执行打包、全局安装、npm exec（npx 的执行机制）、
隔离用户目录下的 `--setup`，并通过系统 Shell 执行生成的状态栏命令。
Unix 还验证符号链接入口与特殊字符路径；macOS 额外验证 Zsh，Windows 验证 CMD 和
Windows PowerShell，检测到 PowerShell 7 或 Git Bash 时也会验证。
查看 [跨平台测试结果](https://github.com/wenxingyu/glm-statusline/actions/workflows/test.yml)。

### 性能检查

源码目录运行 `node scripts/benchmark.mjs`，可离线测量 Node 启动、仅显示模型的完整 CLI 启动、
三家模拟接口并发查询，以及 1 千 / 1 万 / 5 万条合成响应的 token 扫描与缓存读取。
脚本使用独立临时目录和模拟 Key，不访问真实账户或网络；耗时受系统、磁盘、Node 版本影响。

状态栏各分段独立执行 I/O，多个服务商并发查询，输出仍按 `segments` 顺序；
`tok` 和 `speed` 共用一次会话扫描。缓存失效时仍会等待接口结果，慢接口可能等待到 `timeoutMs`。
`auto` 只选择一家服务商，因此多服务商并发主要改善手动启用多家时的刷新速度。

会话记录按偏移增量扫描，但响应去重表仍完整保存在 JSON 缓存中，每次调用都要读取和校验；
长会话会增加缓存解析、内存和写入成本。未启用 `tok` / `speed` 时不产生这部分开销。

## 自动发布到 npm

`.github/workflows/publish.yml` 在推送 `v*` tag（例如 `v1.0.6`）时运行。
先执行 Windows、Ubuntu、macOS 的测试和安装验证，全部成功后才发布。
tag 必须与 `package.json` 的版本一致，`package-lock.json` 的版本也必须同步。
正式版本发布到 npm 的 `latest`，预发布版本（如 `v1.1.0-beta.0`）发布到 `next`。
发布前必须在 `CHANGELOG.md` 中添加 `## 版本号 - YYYY-MM-DD` 条目，写明变化和升级提示，
并更新 README 的版本摘要。缺少对应版本的更新说明会阻止发布。
npm 发布成功后，流水线从更新日志中提取该版本说明并创建 GitHub Release；预发布版本标记为 prerelease。

发布使用 [npm Trusted Publishing（OIDC）](https://docs.npmjs.com/trusted-publishers/)，
无需在 GitHub Secrets 中保存 `NPM_TOKEN`。首次启用时，登录 npm，打开
[`@wenxingyu/glm-statusline`](https://www.npmjs.com/package/@wenxingyu/glm-statusline)
的 Settings → Trusted publishing，添加 GitHub Actions：

| 字段 | 值 |
|---|---|
| Organization or user | `wenxingyu` |
| Repository | `glm-statusline` |
| Workflow filename | `publish.yml`（只填文件名） |
| Environment name | 留空（工作流没有使用 GitHub Environment） |
| Allowed actions | 开启 **Allow npm publish**（直接发布权限） |

先提交并推送工作流及待发布的代码，再在干净的工作区运行：

```bash
npm version patch
git push origin main --follow-tags
```

`npm version patch` 会更新两个版本文件、创建版本提交和 `v` 前缀的 tag；
例如从 `1.0.6` 升到 `1.0.7`。也可以使用 `npm version minor` 或 `npm version major`。
已有版本提交时，在 GitHub 创建指向该提交的同名新 tag 也会触发发布，
仅创建本地 tag 尚不会触发；工作流文件必须存在于 tag 指向的提交中。
相同 npm 版本不能重复发布，发布失败时在 GitHub Actions 中查看日志。
如果 npm 已发布成功、仅 GitHub Release 步骤失败，选择 **Re-run failed jobs** 重试发布说明任务即可。

## 接口说明

| 数据 | 接口 | 认证 |
|---|---|---|
| 套餐额度 | `GET {base}/api/monitor/usage/quota/limit` | `Authorization: <key>`（无 Bearer 前缀） |
| 账户余额 | `GET https://bigmodel.cn/api/biz/account/query-customer-account-report` | `Authorization: Bearer <key>` |
| DeepSeek 余额 | `GET https://api.deepseek.com/user/balance` | `Authorization: Bearer <key>` |
| MiniMax Token Plan | `GET https://www.minimaxi.com/v1/token_plan/remains`（国内）或 `https://www.minimax.io/v1/token_plan/remains`（国际） | `Authorization: Bearer <订阅 Key>` |

DeepSeek 接口字段参照[官方余额文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)，
读取各币种的 `total_balance`，不跨币种相加。缓存按服务商和 Key 哈希隔离，并复用同一套代理设置。
会话扫描缓存位于系统临时目录 `glm-statusline-tokens-v1/`，余额缓存位于 `glm-statusline-v2/`。

- `{base}`：国内版 `https://open.bigmodel.cn`，国际版 `https://api.z.ai`
- 接口为智谱未公开文档的内部接口，参考 [cc-switch](https://github.com/farion1231/cc-switch) 与
  [cc-toolkit](https://github.com/5-seasons/cc-toolkit) 的实现；若上游变更字段，改 `glm.mjs` 的
  `parsePlan` / `parseBalance` 即可
- 额度缓存写在系统临时目录的 `glm-statusline-v2/` 下，文件名按平台与 API Key 的
  SHA-256 哈希隔离，不保存明文 Key。旧版 `glm-statusline-cache.json` 不再读取。
- 套餐和余额分别记录最后成功时间；失败重试遵守缓存 TTL，但不会延长旧数据的有效期。
  关闭余额时不查询、不显示余额，国际版也不会尝试余额接口。
- `--query` 绕过 TTL；若另一个进程正在刷新则返回有效缓存或刷新中状态。
  JSON 中 `age` 表示展示数据中最旧一项的年龄（毫秒），无数据时为 `-1`，
  `stale` 表示正在使用旧数据，`partialError` 表示部分请求失败。

## 许可证

本项目采用 [MIT License](LICENSE)。

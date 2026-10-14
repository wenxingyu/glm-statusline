# glm-statusline

Claude Code 底部状态栏插件：实时显示智谱 GLM 剩余额度（Coding Plan 套餐 + 按量付费余额）。

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

## 版本更新

| 版本 | 主要变化 | 哪些用户建议升级 |
|---|---|---|
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
`--setup` 保留用户配置，并在替换状态栏命令前备份原设置；仅升级全局 npm 包不会更新已部署的运行文件。

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
2. 创建用户配置 `~/.claude/glm-statusline.json`，已有配置保留。
3. 更新 `~/.claude/settings.json` 中的 `statusLine`，保留其他设置。
   如需替换已有设置，会先生成 `settings.json.backup-*` 备份。

升级时重新执行上方带 `@latest` 的安装命令，再运行 `--setup` 更新固定目录中的运行文件。
全局包本身升级不会自动覆盖已部署的运行文件。Linux/macOS 使用 Node.js 绝对路径，
若其安装路径发生变化，请重新运行 `--setup`；Windows 使用 `PATH` 中的 `node`。

### 从源码运行

```bash
git clone https://github.com/wenxingyu/glm-statusline.git
cd glm-statusline
node statusline.mjs --setup
```

重启 Claude Code（或开新会话）即可生效。API Key 自动读取 `~/.claude/settings.json` 的
`env.ANTHROPIC_AUTH_TOKEN`（即你连 GLM 用的那个 Key），也可以用环境变量 `GLM_API_KEY` 覆盖。

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
| `segments` | `["model","dir","git","ctx","glm"]` | 显示的分段及顺序：模型 / 目录 / git 分支 / 上下文剩余 / GLM 额度 |
| `lang` | `auto` | 自动选择标签和状态提示语言；`zh` 固定中文（周），`en` 固定英文（wk） |
| `glm.platform` | `auto` | `cn`（open.bigmodel.cn）/ `en`（api.z.ai）/ `auto`（按 `ANTHROPIC_BASE_URL` 判断） |
| `glm.showBalance` | `true` | 是否查询并显示按量付费余额 |
| `glm.showLevel` | `true` | 是否显示套餐等级（LITE/PRO/MAX） |
| `cacheTtlSeconds` | `60` | 额度查询缓存时间 |
| `staleSeconds` | `1800` | 查询失败时，旧数据距最后成功查询的最大秒数；`0` 禁用失败兜底 |
| `timeoutMs` | `5000` | 单次请求超时 |
| `contextLimit` | `0` | 上下文窗口大小，`0` = 优先使用 Claude Code 上报值，缺失时按模型自动（200k / 1M） |

`lang: "auto"` 优先读取运行环境中有效的 `LC_ALL`、`LC_MESSAGES`、`LANG`，
没有有效值时使用 Node.js `Intl` 提供的系统默认区域语言。中文区域（包括简体、繁体）使用中文，
其他语言、`C` / `POSIX` 区域或识别失败时使用英文。周额度以及缓存、刷新中、查询失败等状态提示一起切换。
这里跟随的是进程可见的区域语言，不读取 Claude Code 的界面语言设置。
修改系统或终端语言后，请重新打开终端并启动 Claude Code，使新的区域设置传入状态栏进程。

新安装默认使用 `auto`。升级会保留已有的 `"lang": "zh"` 或 `"lang": "en"`；
希望自动切换的老用户，更新运行文件后请将 `~/.claude/glm-statusline.json` 中的 `lang` 改为 `"auto"`。
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

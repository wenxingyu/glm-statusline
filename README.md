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
全局包本身升级不会自动覆盖已部署的运行文件。若 Node.js 安装路径发生变化，也请重新运行 `--setup`。

### 从源码运行

```bash
git clone https://github.com/wenxingyu/glm-statusline.git
cd glm-statusline
node statusline.mjs --setup
```

重启 Claude Code（或开新会话）即可生效。API Key 自动读取 `~/.claude/settings.json` 的
`env.ANTHROPIC_AUTH_TOKEN`（即你连 GLM 用的那个 Key），也可以用环境变量 `GLM_API_KEY` 覆盖。

## 配置

编辑 `~/.claude/glm-statusline.json`。配置优先级为：
`GLM_STATUSLINE_CONFIG` 指定的文件 → 用户配置 → 包内 `config.json` → 内置默认值。
仅在文件不存在时继续查找；文件存在但 JSON 无效时使用内置默认值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `segments` | `["model","dir","git","ctx","glm"]` | 显示的分段及顺序：模型 / 目录 / git 分支 / 上下文剩余 / GLM 额度 |
| `lang` | `zh` | 标签语言，`en` 则「周」显示为 `wk` |
| `glm.platform` | `auto` | `cn`（open.bigmodel.cn）/ `en`（api.z.ai）/ `auto`（按 `ANTHROPIC_BASE_URL` 判断） |
| `glm.showBalance` | `true` | 是否查询并显示按量付费余额 |
| `glm.showLevel` | `true` | 是否显示套餐等级（LITE/PRO/MAX） |
| `cacheTtlSeconds` | `60` | 额度查询缓存时间 |
| `staleSeconds` | `1800` | 查询失败时，旧数据距最后成功查询的最大秒数；`0` 禁用失败兜底 |
| `timeoutMs` | `5000` | 单次请求超时 |
| `contextLimit` | `0` | 上下文窗口大小，`0` = 优先使用 Claude Code 上报值，缺失时按模型自动（200k / 1M） |

可以用环境变量 `GLM_STATUSLINE_CONFIG` 指定其他配置文件。字段类型或范围无效时，
该字段使用默认值；`segments` 中的未知项会被忽略，重复项去重，空数组表示不显示任何分段。
`timeoutMs` 必须为正数；缓存时间与上下文窗口必须为非负数。

上下文优先使用 Claude Code 的 `context_window.used_percentage` / `remaining_percentage`，
其次由 `current_usage` 的输入与缓存 token 计算，不计输出 token；显式设置 `contextLimit` 时按该窗口重算。
恢复会话时，当前进程尚未收到 API 响应，实时用量可能为 `null`，此时从 transcript 尾部最近的主会话
assistant 用量估算，并以 `~` 标记。最多检查尾部 4 MiB；没有可靠记录或遇到 `/compact` 边界时显示 `ctx --`，
不把未知数据当作 0%。历史记录不代表精确的实时用量，收到新的 API 响应后自动切换回实时值。
字段含义见 [Claude Code 官方文档](https://code.claude.com/docs/en/statusline#context-window-fields)。

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

GitHub Actions 在 Windows、Ubuntu 和 macOS 上分别使用 Node.js 18.17.0 与 24
运行回归测试和安装测试。安装测试实际执行打包、全局安装、npm exec（npx 的执行机制）、
隔离用户目录下的 `--setup`，并通过系统 Shell 执行生成的状态栏命令。
Unix 还验证符号链接入口与特殊字符路径；macOS 额外验证 Zsh，Windows 检测到 Git Bash 时也会验证。
查看 [跨平台测试结果](https://github.com/wenxingyu/glm-statusline/actions/workflows/test.yml)。

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

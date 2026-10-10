# glm-statusline

Claude Code 底部状态栏插件：实时显示智谱 GLM 剩余额度（Coding Plan 套餐 + 按量付费余额）。

```
GLM-4.6 | glm-statusline | main | ctx 87% | PRO 5h 62% (2h12m) · 周 88% (3d4h) · ¥46.2
```

- `5h 62%` — Coding Plan 5 小时窗口**剩余**百分比，`(2h12m)` 为重置倒计时
- `周 88%` — 每周窗口剩余（老套餐无此项，自动隐藏）
- `¥46.2` — 按量付费账户可用余额（仅国内版；套餐用户可关闭）
- 剩余 ≤15% 红色、≤40% 黄色，其余绿色
- 额度查询结果缓存 60 秒，不会拖慢状态栏刷新

## 安装

在 `~/.claude/settings.json` 中加入：

```json
"statusLine": {
  "type": "command",
  "command": "node \"D:/Code/glm-statusline/statusline.mjs\""
}
```

重启 Claude Code（或开新会话）即可生效。API Key 自动读取 `~/.claude/settings.json` 的
`env.ANTHROPIC_AUTH_TOKEN`（即你连 GLM 用的那个 Key），也可以用环境变量 `GLM_API_KEY` 覆盖。

## 配置

编辑同目录下的 `config.json`（不写就用默认值）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `segments` | `["model","dir","git","ctx","glm"]` | 显示的分段及顺序：模型 / 目录 / git 分支 / 上下文剩余 / GLM 额度 |
| `lang` | `zh` | 标签语言，`en` 则「周」显示为 `wk` |
| `glm.platform` | `auto` | `cn`（open.bigmodel.cn）/ `en`（api.z.ai）/ `auto`（按 `ANTHROPIC_BASE_URL` 判断） |
| `glm.showBalance` | `true` | 是否查询并显示按量付费余额 |
| `glm.showLevel` | `true` | 是否显示套餐等级（LITE/PRO/MAX） |
| `cacheTtlSeconds` | `60` | 额度查询缓存时间 |
| `staleSeconds` | `1800` | 查询失败时，过期缓存的最长兜底时间 |
| `timeoutMs` | `5000` | 单次请求超时 |
| `contextLimit` | `0` | 上下文窗口大小，`0` = 按模型自动（200k / 1M） |

## 调试

```bash
node statusline.mjs --query   # 真实查询一次，打印解析后的额度 JSON（强制绕过缓存）
node statusline.mjs --demo    # 用假数据预览状态栏样式
echo '{"model":{"display_name":"GLM-4.6"}}' | node statusline.mjs   # 模拟 Claude Code 调用
```

排错时设 `GLM_STATUSLINE_DEBUG=1` 可看完整报错。

## 接口说明

| 数据 | 接口 | 认证 |
|---|---|---|
| 套餐额度 | `GET {base}/api/monitor/usage/quota/limit` | `Authorization: <key>`（无 Bearer 前缀） |
| 账户余额 | `GET https://bigmodel.cn/api/biz/account/query-customer-account-report` | `Authorization: Bearer <key>` |

- `{base}`：国内版 `https://open.bigmodel.cn`，国际版 `https://api.z.ai`
- 接口为智谱未公开文档的内部接口，参考 [cc-switch](https://github.com/farion1231/cc-switch) 与
  [cc-toolkit](https://github.com/5-seasons/cc-toolkit) 的实现；若上游变更字段，改 `glm.mjs` 的
  `parsePlan` / `parseBalance` 即可
- 额度缓存写在系统临时目录 `glm-statusline-cache.json`，删除即强制刷新

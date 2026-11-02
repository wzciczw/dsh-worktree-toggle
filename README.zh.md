# dsh-worktree-toggle

**DeepSeek Harness 的「一键 git worktree 启动器」插件。** 输入框的分支标记旁有一个紧凑开关：
点一下，当前会话就在一个全新分支的 git worktree 里继续——不用敲命令、不用再克隆一份仓库、
主检出保持原样。

![switch](icon.svg)

## 为什么用它

在同一仓库里并行干活，通常要在分支之间来回切换，或者额外克隆一份。这个插件把「隔离这个会话」
变成一次点击：worktree 由 harness 自己的 worktree 服务创建，会话工作目录随即迁入，主检出完全不受影响。

## 特性

- **即点即用，零命令** — 在 git 仓库里新建的空会话，输入框工具行会出现 `Worktree` 开关；
  点一下，工作树就绪，会话直接在里面跑。
- **启动快** — 点击路径上没有任何 git 预检进程，唯一等待就是 git 自己的 checkout；
  界面瞬间进入「创建中」状态，不阻塞输入框。
- **不打扰布局** — 固定 22px 高的胶囊，状态切换宽度不变，也不显示分支或 worktree 名称，
  输入框始终是一行。
- **自动清理** — 3 天没有会话活动的 worktree 会被自动删除以释放磁盘空间；分支保留，
  且分两轮确认，刚启动的宿主不会一上来就删东西。
- **与内置能力同一套安全边界** — 创建走 harness 的 `worktrees` 服务，沿用现有沙箱与文件策略，
  产物与 `create_worktree` 工具完全一致。
- **状态可见** — 已在 worktree 中运行的会话，开关是勾选只读态，悬停可看检出路径。

## 安装

插件市场（收录后）：

> Plugins → Discover → 搜索 **dsh-worktree-toggle**。

npm：

```sh
dsh plugin --profile <profile> add dsh-worktree-toggle
```

GitHub：

```sh
dsh plugin --profile <profile> add github:wzciczw/dsh-worktree-toggle
```

安装后重启宿主（或等 profile 重新加载），再刷新页面。

要求 DeepSeek Harness `0.2.1-rc.2` 及以上；已在 Windows 桌面版实测。

## 使用

1. 在 git 仓库里开一个**新会话**。
2. 输入框工具行、分支标记右侧会出现 `Worktree` 开关。
3. 点它。

宿主会在 `<repo>/.agents/worktrees/` 下新建分支和关联检出，把会话工作目录迁进去，
开关变成勾选只读的 `Worktree` 胶囊。之后这个会话里的工具、编辑、命令，全部在新检出里进行。

已经开始的会话、以及不是 git 仓库的目录，不会显示该开关。

## 空闲清理

宿主挂载 20 秒后做第一次扫描，之后每小时一次：

1. 第一次只**登记**空闲 worktree（状态文件里记为 `deferred`）；
2. 下一轮仍然空闲才删除；
3. 只处理 `<repo>/.agents/worktrees/` 下的 worktree，别处创建的关联检出不动；
4. 仍有会话或 agent 在用的 worktree 会跳过；
5. 删除用 `git worktree remove --force`：检出里的文件（含未提交、未跟踪）会没，分支保留。

每轮结果写在 `~/.dsh/dsh-worktree-toggle/gc-state.json`，本插件创建的 worktree 记录在
`~/.dsh/dsh-worktree-toggle/worktrees.json`；其他方式创建的 worktree 在看到活跃会话时会被纳入登记。

## 限制

- 开关只在会话第一条消息之前提供，已开始的会话不能再切 worktree。
- 清理范围限定在仓库根下的 `.agents/worktrees/`。
- 清理后分支保留，检出里未提交的内容不保留。
- 需要宿主 `PATH` 里有 git。

## License

MIT

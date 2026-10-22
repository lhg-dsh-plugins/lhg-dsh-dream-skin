# 发布到 npm 与 GitHub

`dsh-dream-skin` 是一个标准的 dsh 插件包。如果希望用户能一条命令 `dsh plugin ... add dsh-dream-skin`
安装，需要把它发到 **npm 官方源**，并把源码托管到 **GitHub**。

> DSH (rc.6) **没有单独的插件市场**——插件分发渠道**就是 npm 源**。只要有 `dsh.bundle`（host patch 层）和
> `dsh.client`（浏览器 bundle）的包，就能被 `dsh plugin --profile web add <package>` 安装。

## 一、发布前检查

1. 包名全局唯一。scope 名更安全（如 `@你的账号/dsh-dream-skin`）——如需改 scope，改 `package.json` 里的
   `name` 即可。
2. 填好 `author`、`repository`、`description`、`keywords`（均已预留）。
3. 确认 `files` 里带上了这些文件（当前已配置：主 README + `docs/i18n/` 多语言 README + 兼容矩阵）：
   ```json
   "files": ["lib/index.js", "lib/client.js", "lib/types", "cordis.patch.yml",
             "README.md", "docs/i18n", "docs/examples",
             "docs/themes-spec.md", "docs/design-philosophy.md", "docs/desktop-support.md"]
   ```
   这样 npm 只会上传这些，不会带源码里不需要的东西。多语言 README（en/ja/ko/es/fr/de/ru）放在
   `docs/i18n/` 下（根目录只保留中文 `README.md`），同样会随包发布。
   注意：`docs/screenshots/` 与 `docs/previews/` **刻意不在白名单**（前者 v9.26.1 起、后者 10.6.1 起）——
   这两组图是 README 装饰，却要每个 `pnpm add` 的人下载：8 张 `docs/previews/*.png`（720×460@2x）合计 2.26 MB，
   把 tarball 从 930.6 kB 顶到 2.5 MB，而插件本体只有 ~350 kB（issue #83）。README 里的截图、成长图与
   预览色卡全部改指 GitHub 绝对 URL（`raw.githubusercontent.com/.../main/docs/...`），GitHub 与 npm 页面
   都仍可显示。移出白名单后实测：`package size` 2.5 MB → **263.4 kB**，`unpacked` 3.1 MB → **754.2 kB**。
   取舍：图片随 `main` 分支走而非随版本冻结（截图早已如此），代价是 npm 页面的图永远是最新一版的样子；
   反过来把 2.26 MB 塞进每个用户的安装里，是拿所有人的带宽换 npm 页面的离线可用性。`tests/previews.test.cjs`
   把这条策略钉死：`files` 里再出现 `docs/previews` 即红。
   另：预览图内容由 `docs/previews/manifest.json` 指纹守护（见第五节）；`package-lock.json` 的版本
   须与 `package.json`/`PLUGIN_BUILD` 同步（三方评审 T-07）。发布前跑 `npm pack --dry-run`
   核对产物清单。

## 二、GitHub 发布（开源）

```sh
# 1. 初始化 git（若还没有）
git init
git add .
git commit -m "feat: initial release of dsh-dream-skin"

# 2. 在 GitHub 新建空仓库（例如 dsh-dream-skin），然后：
git remote add origin git@github.com:<你的账号>/dsh-dream-skin.git
git push -u origin main
```

> 如果没配 SSH，也可用 HTTPS：`git remote add origin https://github.com/<你的账号>/dsh-dream-skin.git`，
> push 时会提示输入用户名 / token。

## 三、npm 发布

```sh
# 1. 登录 npm（只登录一次）
npm login

# 2. 发布到官方源。注意：如果本机默认源是镜像（如淘宝镜像），它不会真正发布到 npmjs
npm publish --registry https://registry.npmjs.org

# 3. 以后发新版本：改 vERSION（semver），再执行上面的 publish
```

> `npm publish` 退出 0 **不是发布的终点**：那只代表写侧收下了包。发布成功后走第八节，从公共源真装一次、
> 读三个数，再对外报版本号。

检查 publish 前先看本机 npm 源：
```sh
npm config get registry
```

## 四、用户安装

```sh
dsh plugin --profile web add dsh-dream-skin
# 重启 dsh web
```

> 若裸 `add` 报 `ERR_PNPM_ADDING_TO_ROOT`，补 `-w`：`dsh plugin --profile web add -w dsh-dream-skin`。
> 本地开发测试同理：`dsh plugin --profile web add -w /path/to/dsh-dream-skin`。
>
> 刚发出去的那 24 小时内，上面这条裸 `add` 会**静默装到上一个成熟版本**（无报错、退出码 0），成因与实测
> 输出见第八节 8.3(a)；给用户抄的命令一律带确切版本号（`README.md` 的「安装」一节（方式一 / 方式二的命令都写死版本号）与「更新 / 卸载」一节同口径）。

## 五、常见注意事项

- **镜像源**：发布必须 `--registry https://registry.npmjs.org`。
- **版本号**：从 `8.28.0` 起改用**日期式版本** `M.D.X`（月.日.当日第几个版本）。例如 8 月 28 日首版 `8.28.0`、当日再发 `8.28.1`、次日 `8.29.0`。**"日"取 UTC+8**（与维护者本机时区一致；`census` 的 `measuredAt` 用的是 UTC 日期，两者跨零点会差一天，这不是数据陈旧）。当前版本号以 `package.json` 为准（此处刻意不抄录，防陈旧；演进脉络：0.2.0 → 0.4.15 → 8.28.0 → 日期式）。
- **PLUGIN_BUILD 同步**：改版本号时同步 `lib/client.js` 顶部的 `PLUGIN_BUILD` 常量（桌面诊断通道 `window.__DSH_DREAM_SKIN_STATUS__` 上报的构建号）。冒烟测试里有一条断言会拿它比对 package.json 版本——漏改会红。
- **peerDependencies**：以 `^0.1.0-rc.6` 对齐 DSH 当前版本；DSH 升级到正式版后记得跟进。平台客户端包的 peer 均为 `optional`（宿主运行时供给）；`dsh-client-store`（自 2026-08-30 起已在 npm 发布）用宽范围声明以适配宿主换代。
- **engines.dsh（刻意不声明）**：semver 只在候选版本与自身 `major.minor.patch` 相同的轨道放行预发布版本，任何单一范围都无法同时覆盖 `0.1.1-rc.x` 与 `0.1.2-rc.x`；声明反而会广播错误的「不兼容」信号，且宿主不读取该字段。兼容性以 README 兼容矩阵 + 客户端运行时能力探测（平台 seed 全量降级兜底）为准。
- **发布顺序**：先打 tag 并在 GitHub 建 Release（Release notes 引用 CHANGELOG 条目与 npm 链接），再执行 `npm publish`；三处（tag / Release / npm）版本号必须一致。
- **LICENSE / README**：npm 页会展示仓库提交的内容，建议发布前同步。
- **files 白名单**：以 `package.json` 的 `files` 字段为准；除代码与多语言 README 外含
  `docs/examples`、`docs/themes-spec.md`、`docs/desktop-support.md`，保证 npm 包页的示例 / 兼容矩阵链接
  不 404。`docs/screenshots/` 与 `docs/previews/` **刻意排除**（前者 v9.26.1 起、后者 10.6.1 起，真机/无头
  重截图不随包分发），根 README 的截图、成长图与预览色卡已全部改用 GitHub 绝对 URL 渲染。每次发布前
  `npm pack --dry-run` 核对产物清单。
- **预览图指纹**：`docs/previews/manifest.json` 由 `npm run previews` 生成，逐皮肤记录「发货 token 哈希 +
  卡片版式哈希 + PNG 字节哈希/尺寸」。`npm run previews --check` 只读校验（不需要浏览器），`npm test`
  会跑它。改了设计系统颜色却不重照 ⇒ 红，并在报错里点名是哪套皮肤；这一层以前完全无人看守
  （issue #83：实测重掷调色板后 PNG 逐字节不变）。无头浏览器缺失时 `npm run previews` **非零退出**，
  不再把「0 产出」当成功。

## 六、让社区发现你（.dsh-plugin topic / awesome / dsh-market）

DeepSeek Harness「一切皆插件」，社区通过 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
与 [dsh-market](https://github.com/dsh-market/dsh-market)（DSH 内的插件市场）发现插件。

1. **给 GitHub 仓库打 topic**（建仓后），至少包括：
   ```
   dsh-plugin
   dsh-plugin-theme
   deepseek-harness
   dsh
   theme
   skin
   ```
2. **提 PR 收录进 awesome-dsh-plugin**：在 `README.md` 和 `README.zh.md` 的 **「主题与外观」** 分类各加一行：
   ```markdown
   - [RevolutionLA/dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) — 一句话中文/英文描述
   ```
   收录后会自动出现在 dsh-market 的 **主题 Tab**；主题类插件保持**安装即生效、切换即时、选择跨重启保留**。
3. **合入后挂「awesome 已收录」徽章**（README 顶部徽章区加上）：
   ```markdown
   [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
   ```
4. 主题类插件保持**安装即生效、切换即时、选择跨重启保留**——我们已经是这种体验。

## 七、（可选）manifest 契约自检

想确认自己的 `dsh` manifest 符合官方契约，可用社区只读检查器（无需授权）：

```sh
dsh plugin --profile web add dsh-plugin-check
```

## 八、发布后：从公共 registry 真装一次（临时 profile）

**为什么必须有这一步**：本机此前每一次"已验证安装"都是 `link:` 工作区安装——`docs/desktop-support.md` 的「已验证 / 未验证（诚实清单）」一节里「npm 正式包的安装期闸门路径」那一条
把这条欠账写得很清楚（"本机是 `link:` 工作区安装……这一条已在 2026-09-29 实机跑到"）。`link:` 装的是磁盘上的
工作树，它**结构上**碰不到三样东西：npm 的 tarball 与 `files` 白名单（第一节）、registry 的读写同步、
pnpm 的发布冷静期（8.3）。所以"本地装好了 + `npm test` 绿 + publish 退出 0"这三件事加起来，仍然推不出
"用户 `pnpm add dsh-dream-skin@<新版本>` 能拿到正确的东西"。

**这一节的定位（先把没验证的部分说清楚）**：这是一份**人工**发布流程。CI 不跑它——`.github/workflows/` 里没有任何
"从公共源装本包"的步骤（可复现：`grep -rn "registry.npmjs\|pnpm add dsh-dream-skin" .github/` 无输出）；
`tests/` 里也没有任何用例钉住本节的读数（`tests/previews.test.cjs` 里那条 `#83: the previews are advertised from GitHub, not shipped in the tarball`
只钉住 `docs/previews` 不得回到 `files`，`tests/client.smoke.test.cjs` 里那条 `diagnostics: window.__DSH_DREAM_SKIN_STATUS__ …`
用例中的 `bundle build matches package.json version` 断言只比对**工作树**里的 `status.build === pkg.version`）。
下面每条都写着产生它的命令，发布人自己跑；跑不了（没有第二个 profile、没有网络）就不要对外说"发布已验证"。

**8.1 registry 读侧的同步延迟：404 不等于发布失败**

```sh
npm view dsh-dream-skin@<版本号> version --registry https://registry.npmjs.org --prefer-online
```

- registry 自己的发布戳（可复现）：`npm view dsh-dream-skin time --json` → `"10.9.3": "2026-10-09T11:54:34.720Z"`，
  同一次输出的 `"modified"` 是 `2026-10-09T11:54:34.886Z`。
- 2026-10-09 发 10.9.3 时的一次性网络观测（**不可复现复核，只能这样记账**）：发布动作 11:53Z 起，读侧此后约
  **90 秒**仍回 404，约 **3 分钟**后可读。两个时刻不冲突：上面那条 404 观测用的是本地钟，registry 自己记的戳
  （11:54:34.720Z）落在"约 90 秒仍 404"与"约 3 分钟可读"之间——**所以对外报发布时间以 `time` 里那条为准**。
  404 时的错误形状与"版本号打错了"完全同形（对照实验：
  `npm view dsh-dream-skin@10.9.99 version` → `npm error code E404` / `404 No match found for version 10.9.99`）。
- 因此规则是：**publish 后立刻按版本号验会出假警报**。按 `--prefer-online` 重试（每 15 秒一次、上限 10 分钟——
  这两个间隔是本流程的规定，不是测出来的数），超时才回头核对 `npm publish` 的输出与 npm 网页的 versions 面板；
  判据用 `npm view dsh-dream-skin time --json` 里有没有那条时间戳——那是 registry 的记录，比本地缓存诚实。

**8.2 在临时 profile 里装（别拿日常 profile 当试验场）**

`~/.dsh/profiles/` 下本机实存 `web` / `desktop` / `lark` 三个真 profile；`web` 是日常在用的，`desktop` 由
Electron 应用独占（8.4）。验证用一次性目录：

```sh
P="$(mktemp -d)/profile"; mkdir -p "$P" && cd "$P"
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > pnpm-workspace.yaml
printf '{"name":"throwaway-profile","private":true}\n' > package.json
pnpm add dsh-dream-skin@<确切版本号>          # 24 小时窗口内还要带 8.3 的那个 flag
```

（`nodeLinker: hoisted` + `autoInstallPeers: false` 是照真 profile 的形状抄的：`~/.dsh/profiles/desktop/pnpm-workspace.yaml`。
本机 pnpm 11.6.0。）

**8.3 pnpm 的 24 小时冷静期：两种行为，报错形状和处置都不一样**

pnpm 11 的默认冷静期是 24 小时（这个数记在 `README.md` 的「更新 / 卸载」一节；本机**没有**单独验默认值，下面的复现都是把窗口
显式拉大，见每条括号里的分钟数）。`pnpm config get minimumReleaseAge` 返回 `undefined`（2026-10-10 本机复测）
**不影响**策略生效——"我没配过这个策略"不是排除理由（这条与 `docs/desktop-support.md` 的「已验证 / 未验证（诚实清单）」一节里「安装期闸门实机复现与规避」那一条
同口径，那里还钉着 `.npmrc` 写 `minimum-release-age=0` **无效**、只有 CLI 形态被证实）。下面 (a)(b) 两次都在
一次性目录里实跑过，差别必须分清：

复现配方（不必等新版本发布）：临时目录照 8.2 建好，在 `pnpm-workspace.yaml` 里写 `minimumReleaseAge: <分钟>`，
选一个**已发布但被这个窗口盖住**的版本当"新版"——本插件 10.9.1 / 10.9.2 / 10.9.3 三条的发布戳
`npm view dsh-dream-skin time --json` 现场可查，选窗口大过它们即可。

**(a) 不带版本号 ⇒ 静默装到旧版，不报错。** 把窗口拉到 48 小时（`minimumReleaseAge: 2880`）后：

```
$ pnpm add dsh-dream-skin
dependencies:
+ dsh-dream-skin ^10.8.1            ← 10.9.3 仍在窗口内，pnpm 退回上一个成熟版本
Done in 4.8s using pnpm v11.6.0
$ node -p "require('./node_modules/dsh-dream-skin/package.json').version"
10.8.1                               ← 退出码 0，无 error 行
```

**这就是每一条发布出去的安装命令都必须写死确切版本号的原因**（`README.md` 的「安装」一节与「更新 / 卸载」一节）。
写死版本号之后，默认策略下 pnpm 会自己把它记进豁免表并装对（实测输出：`Added 1 entry to minimumReleaseAgeExclude
in pnpm-workspace.yaml (set minimumReleaseAgeStrict to true to gate these updates with a prompt)` + `+ dsh-dream-skin 10.9.3`，
`Done in 2.3s`）；**pnpm 在什么条件下写这张表本机没有定位**，带 `--config.minimumReleaseAge=0` 的那几次它就没写
（`pnpm-workspace.yaml` 逐字节未变），所以不能把"pnpm 会自动豁免"当成 8.3(b) 的解法。

**(b) 锁文件已经钉住一条仍在窗口内的版本 ⇒ 报错点名的是"旧的那条"。** 先装 10.9.2 生成 `pnpm-lock.yaml`
（那一步要带 `--config.minimumReleaseAge=0`，否则装不上），再把窗口改成 `minimumReleaseAge: 1000000`
（≈1.9 年，把 10.9.2 一起盖进去）、`minimumReleaseAgeExclude` 此时只列着要装的 10.9.3：

```
$ pnpm add dsh-dream-skin@10.9.3
✗ Lockfile failed supply-chain policy check (1 entry in 2.4s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  dsh-dream-skin@10.9.2 was published at 2026-10-09T10:36:24.134Z, within the minimumReleaseAge cutoff (…)
exit=1                              ← 装不进去，node_modules 停在 10.9.2
```

点名的是 **10.9.2**（锁文件里那条旧 entry），不是你要装的 10.9.3——**看报错找新版本是找错了对象**。
此时往 profile 的 `pnpm-workspace.yaml → minimumReleaseAgeExclude` 里追加版本号**救不了这一步**：实测把
`10.9.2` 与 `10.9.3` 两条**都**写进豁免表后，裸 `pnpm install` 的锁文件校验确实过了（`Lockfile is up to date`），
但 `pnpm add dsh-dream-skin@10.9.3` 仍拒绝，错误换成
`[ERR_PNPM_NO_MATURE_MATCHING_VERSION] … dsh-dream-skin@10.9.3 was published at 2026-10-09T11:54:34.720Z,
within the minimumReleaseAge cutoff (…)` —— `add` 的解析步骤不读那张表。跑通的只有一条：

```sh
pnpm add dsh-dream-skin@<确切版本号> --config.minimumReleaseAge=0
```

→ `+ dsh-dream-skin 10.9.3`、退出码 0、8.5 的三读数全对（2026-10-10 本机实跑）。这条与 `docs/desktop-support.md` 的「已验证 / 未验证（诚实清单）」一节里「安装期闸门实机复现与规避」那一条
记的"对照实验：`--config.minimumReleaseAge=0` 同样放行（备选手段）"一致。

**8.4 官方桌面 profile：命令行指过去会被硬拒，只有两条路**

官方 DSH Desktop 的 profile 在 `~/.dsh/profiles/desktop`（宿主把 profile 放在 `$DSH_HOME/profiles` 下——这是
`--profile <name>` 选项自己的说明文字；本机实装 `@deepseek-ai/dsh` 0.2.0-rc.1）。这个目录**由 Electron 应用独占管理**：
把 `dsh plugin` 的 profile 参数指向那个名字，宿主 CLI 在动作分派前就拒（`lib/bin.js` 里 `rejectElectronProfile()`
挂在 `--profile` 的处理路径上，早于任何一次 pnpm 调用），用户看到的原样一句是
`error: profile "desktop" is managed exclusively by the Electron application`——本机在
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` 读到该分支
（`if (profile.toLowerCase() === "desktop") program.error(…)`）。**本文件不给出那条命令的形状**：照着敲只会得到
同一句拒绝，而拒绝里没有任何信息告诉用户该走哪条路。完整的成因、证据与告警写法在 `docs/desktop-support.md` 的「官方桌面版：待验条目与判断依据（issue #87）」一节；
README 侧同一事实见 `README.md` 的「兼容性」表里桌面端那一行。走得通的两条，装完都要按 8.5 验：

1. 应用内的插件管理界面（该 profile 目录下的 `.plugin-manager/logs` 是它的痕迹，本机实存）；
2. 在该 profile 目录里手工 `pnpm add dsh-dream-skin@<确切版本号>`。本机现状即这条的产物
   （下面这组读数于 2026-10-12 从 `~/.dsh/profiles/desktop` **只读**取，`node -p require(...)` / `grep` / `find | wc -l`，
   没有走 `dsh --dump-config`，因为那条会写 profile）：
   `package.json` 依赖为 `^10.12.1`、`pnpm-lock.yaml` 钉 `10.12.1`（该条的 `resolution` 是
   registry 的 `integrity: sha512-k7iR2LaNFm/89Lu5hu9J1IfzGKCoCz3owpWw72TX7L/DBFiTyC+qz+pmVDQ4WqMU7vsgMfofWoBEd9pQlSrUjQ==`
   而不是 `link:`，这正是它与工作区安装的区别所在；这串 integrity 与 `npm publish` 的回执、与 `npm view dsh-dream-skin@10.12.1 dist.integrity` **三处逐字符相同**）、
   `node_modules/dsh-dream-skin` 是 24 个文件的 registry 安装物（`PLUGIN_BUILD = "10.12.1"`，与包版本一致）。
   **两点容易被读错的**：① `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 至今仍只列着
   `10.9.1/10.9.2/10.9.3`——名单里既没有 10.10.0 也没有 10.12.0，而这两版都确实装进去了（lock 钉着），
   所以那几次**不是**靠改这份名单放行的；结合 8.3(b) 记录的冷静期行为，剩下的出口就是命令行上的一次性
   `--config.minimumReleaseAge=0`。这条推断双向有用：**"名单里没有新版本"不等于"新版本装不上"，
   "名单里有"也不等于"装的就是它"**——判第三件事只看 lock 与安装物读数；
   ② **文件层与进程层是两件事**：2026-10-12 用户开口要 10.12.1 之后，维护方在该目录里按本节这条路装上（`pnpm add dsh-dream-skin@10.12.1 --config.minimumReleaseAge=0`，18 秒完成，其中一次 registry GET 遇到 `ECONNRESET` 由 pnpm 自己重试扛住），装后现核三读数 = `^10.12.1` / `PLUGIN_BUILD = "10.12.1"` / 24 文件；**但装的时候应用正在跑**（`tasklist` 里 5 个 `DeepSeek Harness` 进程在场，维护方没有代关掉它），所以**渲染进程里加载的仍是重启前的 `10.12.0`**——"目录里已是新版"与"界面上还是旧版"此刻同时为真，后者要等用户本人重启。刚发出去的那 24 小时内走这条会撞上 8.3(b)：
   2026-10-09 在该目录里遇到的就是它，本机 2026-10-10 在临时目录里用"把窗口拉大到覆盖已装版本"的办法复现了同一条
   报错，当时实测只有 `--config.minimumReleaseAge=0` 通。
   **一条自我打脸的记录，留着当教训**：上面这段"本机现状"此前写的是 `^10.9.3`，而 ``git log --oneline -S'依赖为 `^10.9.3`' -- docs/publishing-to-npm.md``
   显示那半句是 10.10.0 那轮（`aa6c36c`）引进来的——也就是**落笔时就已经是旧读数**（同一轮里该 profile 装的是 10.10.0），
   此后 10.12.0、10.12.1 两轮都没回头改。而 10.12.1 的修正又是**在发布之后**做的——所以 `npm` 上那个
   `dsh-dream-skin@10.12.1` 的包内本节仍写着 `^10.9.3`，要到下一版才对得上。以"现状"自称的段落必须带取数日期，
   且下一轮发布前要重读一遍；评审把这条从 🟡 升级为 🟠（以"现状"自称又与现场矛盾 = 声明失实）的理由就在这里。

**8.5 验"到底加载了什么"，三个读数 + 一条装载计划**

前三条命令跑在**临时目录**里（文件层，不需要宿主）；第四条 `npm pack --dry-run` 跑在**仓库**里，它给的是对照基准。
宿主页面上的那条（下面那段 `--dump-config`）才需要对**真 profile** 动手——别为了验它把新包塞进日常在用的那个：

```sh
node -p "require('./node_modules/dsh-dream-skin/package.json').version"
grep -o 'PLUGIN_BUILD = "[^"]*"' node_modules/dsh-dream-skin/lib/client.js
find node_modules/dsh-dream-skin -type f | wc -l
npm pack --dry-run          # 在仓库里跑，拿它的 total files 跟上一条比
```

对照物（都不许凭记忆）：仓库 `package.json` 的 `version`、`lib/client.js` 里 `const PLUGIN_BUILD = "…"` 那一行（**别写行号**——这一节自己就改过它几次）、`npm pack --dry-run` 的 `total files`。2026-10-10 本机实跑：`npm pack --dry-run` 报 `total files: 22`，registry 安装物
三个读数 = `10.9.3` / `PLUGIN_BUILD = "10.9.3"` / `22`，逐项一致；安装物里 `scripts/`、`tests/`、`CHANGELOG.md`、
`docs/screenshots/`、`docs/previews/` 全部不存在
（前三个被 `package.json` 的 `files` 白名单挡在外面，后两个是 issue #83 起刻意排除，见第一节与第五节）。
**2026-10-12 发布 10.12.1 后同一条重跑（临时目录 `npm install dsh-dream-skin@10.12.1`）**：三读数 =
`10.12.1` / `PLUGIN_BUILD = "10.12.1"` / `24`，与同轮 `npm pack --dry-run` 的 `total files: 24` 对上；
再加两条形同"把包拆开看"的核对：安装物的 `dist.integrity` 与发布回执、与 `npm view dsh-dream-skin@10.12.1 dist.integrity`
三处逐字符相同（`sha512-k7iR2LaNFm/89…oBEd9pQlSrUjQ==`），且 `grep -c channelAbsent` 在**发货的** `lib/client.js`
里读到 14 处——第四池不是只活在仓库里。registry 侧 `dist.fileCount = 24`、`dist.unpackedSize = 1071403` 亦同轮现读。
**同一命令在 10.10.0 的工作树上重跑是 `total files: 24`**——多出的两个是本轮 B-04 补进 `files` 的
`docs/publishing-to-npm.md` 与 `docs/computed-style-gate-in-ci.md`（这两份是"访客要能自己复算门"的说明，
不发出去就等于让人来问）。所以上面那组 22 是 **10.9.3 安装物的实测读数**，不是当前仓库的对照基准；发版时
三个读数都要现取，别拿这一节的历史数字当基准。
**只比 `total files`，别比体积**：第一节那对 `263.4 kB / 754.2 kB` 是 issue #83 那轮改排版时记下的**当时**读数，
本次同一条命令报的是 `344.3 kB / 947.5 kB`——两个数不同只是量于不同轮次，本文件不去解释差从哪来（要盯体积就每次
现读 `npm pack --dry-run` 的两栏，与**上一次发布**的读数比，而不是与文档里的历史数比）。
**为什么 `PLUGIN_BUILD` 不能省**：`package.json` 只是包的元数据，它的版本号对了，并不说明浏览器真正加载的
那份 `lib/client.js` 是新的——两者不同步就意味着"包装上了、跑的是旧 bundle"，而 registry 侧没有任何门会为此翻红
（仓库侧的同步断言见第五节 PLUGIN_BUILD 条目与 `tests/client.smoke.test.cjs` 里那条
`bundle build matches package.json version`）。

装载计划半边（真 profile 上）：

```sh
dsh --profile web --dump-config | grep -A2 dream-skin
```
```
# == dsh-dream-skin
- id: dream-skin
  name: dsh-dream-skin
```
（第二段是本机实跑输出，逐字。）

这条只证明**宿主打算载它**，不证明渲染进程里真挂载了——口径见 `docs/desktop-support.md` 的「已验证 / 未验证（诚实清单）」一节（"验证止于安装期放行
+ `--dump-config` 里出现 `- id: dream-skin` 条目"）。运行期证据是页面里的 `window.__DSH_DREAM_SKIN_STATUS__`
（其 `build` 就是 `lib/client.js` 顶部的 `PLUGIN_BUILD`），官方桌面壳上读到过 `build:"10.9.1"` / `"10.9.2"`，
但那属于第九节的分诊材料，不是本文件能替下一次发布担保的东西。

## 九、桌面用户报"修复没生效"：先分诊他实装的版本，再讨论修复

老 profile 的依赖范围若是 `^9.29.0`，10.x **按 semver 就到不了**——拿宿主自带的那份 semver 现场判
（本机实装是 `@deepseek-ai/dsh` 0.2.0-rc.1，它自带 `semver` 7.8.5，路径用 `%APPDATA%` 展开，换机器不用改命令）：

```sh
node -e "const s=require(process.env.APPDATA+'/npm/node_modules/@deepseek-ai/dsh/node_modules/semver');console.log(s.satisfies('10.9.3','^9.29.0'), s.satisfies('10.9.3','^10.9.0'))"
# false true     ← 2026-10-10 本机实跑：^9.29.0 收不到 10.9.3，^10.9.0 收得到
```

`dsh plugin update` 会不会跨大版本把它抬上去——**这一半本机未证**，`CHANGELOG.md` 的 10.9.1 版块「报告人需要自己抬版本」那条写得很明白（"本机 0.2.0-rc.1
的 CLI 里没定位到可复核的实现，蓝军同样没定位到，本版不替它背书"），`CHANGELOG.md` 的 10.9.1 版块与 `docs/desktop-support.md` 的「已验证 / 未验证（诚实清单）」一节
只是那样记的。所以处置顺序是：**先读用户那份 `node_modules/dsh-dream-skin/package.json` 的版本号**（8.5 的第一条
读数），再谈修复有没有效——10.9.1 / 10.9.2 两轮里报告人看到的那两处旧缺陷正是"版本没到"，而 `CHANGELOG.md` 的 10.9.1 版块、
`docs/desktop-support.md` 的「已验证 / 未验证（诚实清单）」一节都记着"是版本没到，不是修复无效"：那种报告按第八节的安装路径送达新版即可结案，
不该开新的修复轮。

## 十、宿主出新 rc 的那天：跑一次预检（`npm run host:preflight`）

**为什么这是一条动作而不是一句提醒**：issue #62 的根因不是"缺工具"，是"没人重复做"——`0.2.0-rc.1`
起宿主在 boot 阶段读我方 `@deepseek-ai/dsh*` peer 范围，**不满足就整包跳过**（表现是"皮肤一夜全消失"），
而宿主持续发 rc / alpha。所以"今天最新那个宿主在不在窗内"会自己过期。`scripts/host-preflight.cjs`
把这个问题变成一条命令，并且**能失败**。

```sh
# 发布日形态：读 registry + 本机宿主，跑真实判定表
HTTPS_PROXY=http://127.0.0.1:7890 npm run host:preflight -- --profile-load

# 离线 / CI：judgement 用捕获下来的 packument 跑（不碰网络）
npm run host:preflight -- --packument tests/fixtures/host_packument_sample.json
```

读数是这三行（2026-10-13 本机实跑）：判定表说 31 个已发布宿主版本里 **26 个在窗内**、
按发布时间最新的 `0.2.1-alpha.2`（`2026-10-09T08:18:00.501Z`）**在窗内**，`--profile-load` 那半
读出真实 web profile 的 bundle 层数与我方是否被挂载。**判定值的来源是宿主自己那份
`evaluatePluginCompatibility()`**（本机 `@deepseek-ai/dsh` 0.2.0-rc.1），不是本仓库重算的区间——
机器上没有宿主时它退回零依赖镜像实现 `scripts/lib/peer-window.cjs`，**并在第一行把退回这件事印出来**；
两份都在时逐版本要求一致，不一致就是镜像漂了（红在"去重生成
`tests/fixtures/host_compat_verdicts.json`"那句话上，而不是安静地出一份好看的表）。

**四个出口，别混**（与 `wash:check` 同一套纪律，见 issue #102）：

| exit | 含义 | 该做什么 |
| --- | --- | --- |
| 0 | 跑过了，且最新发布的宿主在窗内 | 什么都不做，这次预检就是它的目的 |
| 1 | 跑过了，但**最新**宿主落在窗外（或两份尺子不一致） | 见下"红了怎么办"——**只有"最新"能判红**，5 个 0.0.x / 0.1.0-rc.2-3 的历史版本在窗外是事实不是故障 |
| 3 | 环境不给跑（没网络、读不到 registry、没宿主），**不算通过** | 补上那一样再跑；把 3 当成 0 就是这次变更要防的那种自欺 |
| 4 | 要了严格模式（`DSH_PREFLIGHT_STRICT=1`）却没跑成 | 这是流水线/清单坏了，按它点名的那一件（`registry` / `host install` / `profile`）修 |

`--strict` 只是 `DSH_PREFLIGHT_STRICT=1` 的显式写法；发布清单请带它，因为"没跑成"和"跑了且没事"
在无人值守的通道上必须长得不一样。

**红了怎么办（只有两条诚实出口）**：① 对着那个版本跑一次判定表 + 一次真实 profile 载入，通过才把
`package.json` 里那六条 peer 的上界抬上去，并**同轮**重生成 `tests/fixtures/host_compat_verdicts.json`
（判定值必须继续来自宿主自己那份 checker，见第八节 8.6 与 `tests/package.host_compat.test.cjs`）；
② 不抬，就在 8 份 README 的兼容表里写明"该宿主不支持"并给出用户的处置。**没有第三条**：把表原样留着、
只在群里说一句"新版可能不兼容"，就是 #62 当时的形状。

**这条动作由谁守**：`tests/host.preflight.test.cjs` 里有一条门要求 `package.json` 有 `host:preflight`
这个 script、本节文档必须点到命令名与 `--profile-load`、并写明 exit 3 **不算通过**与 exit 1 是"窗外"——
删掉本节或把措辞磨圆，那条门会红。

## 十一、第三方目录的"源码审核面"按单文件字节设限时，先量宿主能不能让你拆

DSH STORE（`AI-Scarlett/DSH-Store`）对固定 Commit 做自动收录检查，其契约（`registry/README.md`）写着自动审核面的硬上限：**最多 240 个运行时文件、单文件 262,144 字节（256 KiB）、合计 2,097,152 字节（2 MiB）**，超限**失败关闭**并附带报"扫描面不完整"。我方 `lib/client.js` 是 442,975 字节 ⇒ 撞单文件上限，catalog 被标 blocked（2026-10-14 issue #1411）。

> **【10.16.0 就地更正：上面这段的前提已被对方收回，原文保留不删】** 复核方在 2026-10-15 的追评（`AI-Scarlett/DSH-Store#1411`，原文与正文 sha256 存档在 `docs/evidence/dsh-store-1411-followup-2026-10-15.md`）里明确"the old report conflated a per-file limit with the total… That diagnostic was incorrect"，并把边界改为 **4 MiB/文件、8 MiB/总量、512 源文件**；在新边界下他们写下"**Your 442,975-byte client needs no minification or splitting**"。也就是说本节 2026-10-14 那两条实测（① 宿主 combo 加载决定了浏览器半边必须单文件；② 同一台机器上 8 个同行插件同样超那个数）**仍然成立且有价值**，但它们所回应的那条**检查本身是错的**——我方当时拒绝"为了字节数牺牲审计面"的处置，事后看方向也对。catalog 当时仍 blocked，阻塞点换成了另一件事（`requireSeed()` 里 `require(name)` 的"有限调用集不可证"），由 10.16.0 处理：见 `docs/desktop-support.md` 的「可审计能力面」一节。本节其余内容作为"外部判据逼你改形状时先量这形状是谁定的"的方法记录保留。

**先量再决定改什么，两件事都是实测（2026-10-14，本机活页）：**

1. **浏览器半边必须是单文件，这是宿主加载器决定的**：宿主把全部插件的 client 拼成一个 combo 请求送进浏览器——
   `/plugins/??pkgA/client.js,…,dsh-dream-skin/client.js&rev=…`；包内同级路径一律 **404**（实测 `/plugins/…/types/index.d.ts`、`…/index.js`、`…/locale/zh.json` 全 404）。
   所以"把 443 KB 拆成几个 chunk"在 DSH 里不是一个可选项，而不是我们不愿做。
2. **这条上限对生态是普遍超的**：同一台机器上 **8 个第三方插件的 `lib/client.js` 都 > 262,144 字节**，最大 **2,468,635 字节**（`@linxin666/dsh-web-all`）。也就是说这不是"我方特例"，而是"审核边界遇上宿主形态"。

**因此本项目的处置是**（写在这里，避免下一次有人临时发明做法）：

- **不把运行时入口压小去迁就审核器的字节预算**——不 minify、不删注释、不剥符号。这个文件同时是本项目的**审计面**（对外承诺是"可读的原生 token 源码、无注入"），仓库里几十道门读的就是它的文本，而他们的契约本身也把"混淆"列为信号。为了字节数牺牲这些，是拿用户的可核验性换一次自动批准。
- **把增长变成看得见的决定**：`tests/package.runtime_size.test.cjs` 给每个发货的 JS 运行时产物设一个**声明的天花板**（`lib/client.js` 480 KiB、`lib/index.js` 40 KiB），超了红；并且要求"新多出来一个发货的 .js 却没设天花板"也红（这是"第二运行时入口"藏身的地方）。第三方上限写在门里作为**事实**而不是我方判据——**不要**把门写成"必须 < 262,144"，那是一盏在我方结构下永不绿的灯（#98 那一轮刚为同一种灯写过撤回理由）。
  10.14.3 的原文（逐字保留）：

  > - **能修的只有通配那一处，但它有前置**：他们的报告还点了 `runtime artifact pattern requires review: ./locale/*.json`。这一枚通配**是承重的**——`tests/package.i18n.test.cjs` 记着"删掉 `./locale/*.json` 这个 exports 模式，宿主会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`"（宿主按自己的语言码去解析子路径）。所以要么保留通配并走他们的人工审阅，要么先拿到宿主究竟会请求哪些语言码的证据再枚举。**别为了消掉一条模式告警去动插件列表的多语言解析**。

- **通配那一处：10.14.3 说"不动"，10.15.0 动了，因为它当时的那条理由是未经实测的推断**。报告还点了 `runtime artifact pattern requires review: ./locale/*.json`。10.14.3 的原文是"这一枚通配**是承重的**——删掉它宿主会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，所以要么保留并走人工审阅，要么先拿到宿主究竟会请求哪些语言码的证据再枚举"。**那句"承重"是推断，不是读数**，而它要的那个证据现在拿到了：直接调用宿主自己的 `readPluginMeta()`（`@deepseek-ai/dsh-app-boot`，装在 `@deepseek-ai/dsh@0.2.0-rc.1` 里）对 **14 份 staged manifest + 11 枚文件名探测**跑出实测判定，落在 `tests/fixtures/plugin_meta_readings.json`，由 `scripts/gen-plugin-meta-readings.cjs` 生成：
  - 宿主**不猜语言码**——它 `readdir` 那枚 `locale/` 目录，把里面**每一个** `.json` 逐个解析。所以"显式枚举"覆盖得到它将要请求的全部文件，通配在这里没有多做任何事。
  - `locale/en.json` 走的是 `optionalResourcePath`：English 不在场**或没被导出**时宿主不抛，只是整行退回 manifest 的 `name`/`description`（实测 `outcome: manifest-fallback`）。
  - English 解析成功之后，其余语言文件走**会抛**的 `resolvePluginResource`：一枚在场却没被导出的文件 ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED` 被 `readPluginMeta` 接住变成 `{ error: … }`，**宿主不坏，我方这一行同时失去标题、描述与图标**（实测 `outcome: error`，`errorSubpath: "./locale/ja.json"`）。
  - **文件名也是一条独立车道**（本轮实测发现的）：`dictionariesOf()` 在解析之前先 `LANGUAGE_ID.test(stem)`。11 枚候选名逐个交给宿主跑的结论是**接受** `ab` / `abcdefgh` / `zh-CN` / `zh-CNA` / `zh-Hans-CN` / `en-US`、**拒绝** `a` / `abcdefghi`（9 个字母）/ `e2`（主码里带数字）/ `zh-CCCCCCCCC`（子码 9 个字符）/ `zh_CN`（下划线）。被拒的名字**即使导出齐全**也让 `readPluginMeta` 整个失败 ⇒ 那一行失去标题、描述与图标。所以新增语言时**两件事都要对**：文件名合法 **且** 显式导出。
  - **优先级也量过**：一枚被拒的文件名 + English 没导出 ⇒ `manifest-fallback`（不抛），因为 English 是进入目录循环的那道门。
  - **测不到的一支**：`duplicates locale` 需要两枚只差大小写的文件名在同一目录共存，Windows 造不出这个夹具——这一支既没被见证也没被建模，别把它算进"已覆盖"。
  - **键在场而目标坏掉，是本轮蓝军抓出来的 🔴（`BLUE-10150` BL-01）**：`exports` 的解析是**按子路径**发生的，所以一枚看起来"枚举齐全"的 manifest 可以有四种各自会抛的值——目标不存在 ⇒ `ERR_MODULE_NOT_FOUND`、目标在别的目录 ⇒ "must share the English locale directory"、值写成 `{require: …}` 或 `null` ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED`。旧那版门只读**键名**，对这四种形态全绿，而宿主把整行销毁。现在的不变式因此是**恒等映射**：`./locale/<x>.json` 必须指向 `./locale/<x>.json`，且每个 locale 条目必须是**常规文件**（目录名伪装已实测会抛）。这比宿主本身更严——严的理由是可审性加"坏法只有这几种"的实测清单，不是洁癖。
  - **图标与文本是两条契约**：删掉 `./package.json` 那枚导出，标题与描述照常、图标静默消失（实测 `outcome: localized` + `hasIcon: false`）。门里两条分开断言，并有一条对照腿钉住"掉 `./package.json` **不**改变文本判定"。
  - **仍未建模的一支（洞，不是覆盖）**：一枚**逃逸到包外的符号链接**会让宿主报 "must share the English locale directory"，我方现在既不见证也不断言——要补它，先在生成器里把这个夹具造出来并让它跑红。
  - **`optionalResourcePath` 的"可选"只覆盖缺失，不覆盖坏**：English 不在场 / 没被导出 / 目标不存在 ⇒ 静默退回 manifest 文本；English 那一枚是**目录**时走会抛那一支，文本与图标一起没（实测 `ERR_UNSUPPORTED_DIR_IMPORT`）。
  - 通配本身：宿主照旧解析成功（实测 `outcome: localized`）——**所以 10.14.3 那句"删掉会抛"是错的**，它把"某一枚文件没被覆盖"的后果写成了"通配消失"的后果。
  - **维护动作**：动过 `locale/` 目录或 `exports` 之后，在**装有宿主的机器上**重跑 `node scripts/gen-plugin-meta-readings.cjs`。它没找到宿主时 `exit 2` 并说明"我方自己的镜像不算见证"，跑不出两种失败形状时**拒绝写表**——这两个出口是刻意的：一张由推断生成、或全绿的见证表，比没有表更坏。CI 不跑它（CI 上没宿主），CI 读的是提交进仓库的那份。
  改成显式枚举的真实代价是：不变式从"通配自动兜住"变成"有人记得"，所以同轮把 `tests/package.i18n.test.cjs` 换成双向门（在场↔导出两个方向都查、通配本身也点名），并让它**与那份宿主实测逐格比对**——镜像算错任何一个形状都会红在"mirror predicts X but the host returned Y"上。同时留了两条对照腿：通配与"导出指向不存在的文件"在宿主侧都**不**改变读数，所以那两条只由策略腿红，别把两件事混成一句。
- **给下一轮的一条自纠**：写下"某处是承重的、所以不动"时，先问这句是从哪儿知道的。这里的答案本来只要一次 `import()` 宿主模块就能读到，而我用了推断去保护一个功能，还把推断写进了发货文档。**"未经实测的前提"一旦进了文档就会变成下一轮的理由**，这条比上面那枚通配本身贵。
- 复检是他们每八小时自动跑，不需要我方回复"确认"；但要澄清哪一条上限真的命中了（他们的报告把"合计 467,678 字节 / 上限 2,097,152"写成"exceeds"，而 467,678 小于上限——见 issue 内的回复）。


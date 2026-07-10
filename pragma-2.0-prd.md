# Pragma 2.0 PRD：面向 Gitea Issue 化流程的 AI-native 设计上下文交付

> 文档状态：Pragma 2.0 当前主 PRD；代码实现以 `D:\tianrui_pan\code\pragma-2.0` 为准  
> 历史讨论稿：`archive/pragma-2.0-discussions/pragma-2.0-mvp-discussion.md`、`archive/pragma-2.0-discussions/gitea-issue-design-workflow-discussion.md`  
> 目标版本：Pragma 2.0 MVP  
> 核心定位：设计师端生成自我包含 Design Context Package，Gitea Issue 轻量引用，Codex Agent 按需读取并开发  
> 默认存储：同一 Gitea repo 默认分支提交版本化 context 目录；超过 20MB 走公司 MinIO bucket `product-project-dev-lab`  

---

## 1. 背景

公司正在探索基于 Gitea Issue 的开发协作流程：

```text
飞书 PRD          = 业务需求共识层
飞书多维表格       = 项目协同层
Gitea Issue       = 研发执行事实层
Gitea PR / CI/CD  = 工程证据层
Codex Agent       = 执行加速器
```

在这个流程中，产品需求会被拆解为一组可执行、可验证、可 Review 的 Gitea Issue。Codex Agent 主要通过 Issue 获取任务目标、范围、验收标准和开发约束。

但涉及 UI、视觉、交互、切图、设计意图的 Issue，仅靠 Issue 文本和设计稿链接不足以让 Agent 稳定完成开发：

- 开发人员可能没有 Figma Professional seat，无法访问 Figma MCP。
- 当前人类开发主要依赖蓝湖查看尺寸、切图、标注。
- Agent 不能稳定消费蓝湖页面或一张设计截图。
- 设计稿里存在大量“表达意图而非最终实现”的区域，例如地图、图表、视频流、三维场景、实时数据等。
- 不希望把大量设计信息直接塞进 Gitea Issue，避免 Issue 本体臃肿。

因此需要 Pragma 2.0 作为设计侧到研发侧的轻量交付层。

---

## 2. 产品定位

Pragma 2.0 不是新的 Issue 系统，不替代 Figma、蓝湖、Gitea、PR、CI/CD，也不是设计 CI 平台。

Pragma 2.0 的 MVP 定位是：

> **AI-native 设计上下文交付层：设计师端 Figma Plugin / Capture Bridge 读取 page/components/assets 三类设计输入，冻结为自我包含、可版本化、可被 Gitea Issue 引用、可被 Codex Agent 读取的 Design Context Package。人类查看与兜底验收在 MVP 阶段继续保留蓝湖。**

协作关系：

```text
Figma / 设计工具
  -> Pragma Design Context Package
  -> Gitea Issue 引用
  -> Codex Agent 读取
  -> 开发实现
  -> PR / 人类验收
  -> 不通过则回到 Issue loop
```

---

## 3. 目标

### 3.1 业务目标

1. 让设计相关 Issue 能被 Codex Agent 稳定消费。
2. 让开发人员不依赖 Figma MCP 权限，也能获得必要设计信息。
3. 保持 Gitea Issue 轻量，只承载任务契约和设计上下文引用。
4. 保留蓝湖作为人类查看、切图、标注和兜底开发路径。
5. 为未来切换 Pencil、Penpot 或其他设计工具保留适配空间。

### 3.2 产品目标

1. 设计师端 Figma Plugin / Capture Bridge 可以采集 page frame，并按需选择或复用 components/assets shared snapshots。
2. Design Context Package 包含 Agent 开发需要的设计意图、结构、关键尺寸、样式、素材索引、截图、动态区域说明和依赖锁。
3. 页面 frame 下每个实现节点和组件实例的位置写入 normalized pixel spec，组件/切图总表通过 snapshot 依赖维护。
4. Pragma context 归属于同一个 Gitea repo；20MB 以内提交完整版本目录到 `.pragma/design-contexts/issue-<n>/versions/vN/` 路径，不提交 context.zip。
5. 超过 20MB 的完整包发布到公司 MinIO，repo 内保留 manifest、agent-context、pixel-spec、dependencies 和素材索引。
6. Gitea Issue 只引用 Pragma context，不承载大量设计内容。
7. Governance Runner 在启动 Codex turn 前按稳定文件协议解析并 pin 上下文包，Codex Agent 直接读取 Runner 提供的 descriptor 和只读文件；开发者、Codex app-server 与开发 Agent 均不依赖 Pragma CLI。

### 3.3 非目标

MVP 不做：

- 不替代 Figma、蓝湖、Pencil 或其他设计工具。
- 不重做蓝湖 Inspect 页面。
- 不做完整设计系统平台。
- 不做全页面像素级视觉 CI。
- 不自动判定设计验收通过或失败。
- 不接管 Gitea Issue 生命周期。
- 不自动关闭 Issue。
- 不要求所有 Issue 都经过 Pragma。
- 不把大素材直接塞进 Issue body 或 Agent prompt。

---

## 4. 用户与角色

| 角色 | 诉求 | 与 Pragma 的关系 |
|---|---|---|
| 设计师 | 从 Figma 生成可交付给研发和 Agent 的设计上下文 | 主要生产者 |
| 前端开发 | 获取设计信息、蓝湖链接、素材和实现注意事项 | 人类消费者 |
| Codex Agent | 读取 Issue 和 Pragma context 后实现代码 | 机器消费者 |
| 产品 / 项目负责人 | 确认 Issue 范围和结果是否符合需求 | 验收参与者 |
| 测试 / 交付 | 根据 Issue 与实现效果进行验证 | 验收参与者 |
| 技术负责人 | 保证流程不破坏 Gitea Issue / PR / CI 边界 | 流程治理者 |

---

## 5. Dev Issue 与 Design Issue 模型

Issue 默认都需要人类验收，因此 Pragma 不单独设计 `design/review-required`。为降低 Issue 模板复杂度，开发 Issue 不再使用 `design/none` / `design/reference` / `design/context` 三分类，只回答一个问题：**这个开发 Issue 是否需要一个 Design Issue 才能开工？**

```text
需要 Design Issue：否
- 不需要新增设计交付；开发 Issue 自身已能描述任务。
- 可以包含 Figma / 蓝湖链接作为人类参考，但 Codex Agent 不依赖 Pragma context 开发。

需要 Design Issue：是
- 需要设计师产出设计稿、设计说明或素材。
- 需要 Pragma Design Context Package 作为开发 Agent 可读的设计上下文。
- 开发 Issue 必须依赖同 repo 中的 Design Issue。
```

### 5.1 判断规则

| 状态 | 判断依据 | 是否创建 Design Issue | 示例 |
|---|---|---|---|
| 不需要 Design Issue | 不改用户可见 UI / 交互 / 素材 / 视觉表现，或只是已有页面的小改动，开发 Issue 已写清实现方式 | 否 | 后端接口、配置、数据修复、脚本任务、已有页面文案替换、已有组件开关 |
| 需要 Design Issue | Codex Agent 需要根据设计稿实现 UI，或需要设计师提供尺寸、布局、素材、组件状态、设计意图、动态区域说明 | 是 | 新页面、新弹窗、复杂 UI、大屏、地图、客户交付页面、视觉重构 |

设计链接的用途不再单独形成分类：如果只是给人类查看，可以直接放在开发 Issue；如果 Agent 开发必须依赖设计信息，就创建 Design Issue 并交付 Pragma context。

### 5.2 Design Issue 依赖模型

当开发 Issue 需要 Design Issue 时，Pragma context 不直接塞进开发 Issue，而是由独立的 Design Issue 交付。两个 Issue 放在同一个 repo，通过通用 issue dependency 建立阻塞关系。

```text
#101 [Feature] 实现地图监控页
  需要 Design Issue：是
  depends on #102

#102 [Design] 地图监控页设计交付
  output: Pragma Design Context Package
```

Design Issue 在 PRD / 飞书讨论 intake 阶段即可创建，但此时通常还没有 Pragma 链接。它初始状态应显示为“待设计 / 待生成 Pragma Context”。开发 Issue 只保留依赖路标；详细设计事实集中在 Design Issue 和 Pragma Design Context Package 中。

---

## 6. Gitea Issue 设计相关写法

Gitea Issue 本体要尽可能轻量，避免成为设计说明书。开发 Issue 只说明是否需要 Design Issue；设计细节集中在 Design Issue 和 Pragma Design Context Package 中。

### 6.1 开发 Issue 中只保留设计路标

不需要 Design Issue 的开发 Issue：

```markdown
## 设计输入

需要 Design Issue：否
设计说明：本 Issue 不依赖新增设计交付；如有 Figma / 蓝湖链接，仅作为人类参考。
```

需要 Design Issue 的开发 Issue：

```markdown
## 设计输入

需要 Design Issue：是
Design Issue：#102
设计状态：待设计交付
```

开发 Issue 不应直接承载 Pragma package 链接、详细设计说明、尺寸或切图。Codex Agent 应通过 dependency 追溯到 Design Issue，再读取 repo 默认分支中的 Pragma context。

### 6.2 Design Issue 初始写法

Design Issue 是设计交付任务。它创建时通常还没有 Pragma 链接，因为设计师还未完成设计。

```markdown
## 设计目标

为哪些页面 / 功能 / 开发 Issue 提供设计上下文？

## 关联开发 Issue

将解锁：
- #101

## 设计来源

Figma：待补充
蓝湖：待补充

## 动态区域 / 非像素还原说明

待补充

## Pragma Design Context

状态：待生成
Current Pointer：待补充
Current Manifest：待补充
Package Path：待补充
版本：待补充
Checksum：待补充
Context PR：待补充
Merged Commit：待补充

## 完成条件

- [ ] 设计稿已完成并确认
- [ ] 蓝湖链接已生成，如需要
- [ ] 动态区域 / 非像素还原说明已补充
- [ ] Pragma Context 已生成
- [ ] Pragma context 已写入设计分支的 `.pragma/design-contexts/issue-<n>/versions/vN/`
- [ ] 设计分支已通过 PR 合入 repo 默认分支
- [ ] 如上下文包超过 20MB，context.zip 已发布到公司 MinIO
- [ ] Design Issue 已回填 current pointer、manifest、version、checksum、PR 和 merged commit
- [ ] 关联开发 Issue dependency 已建立
```

### 6.3 Design Issue 完成后回填

```markdown
## Pragma Design Context

状态：已生成 / 已合入默认分支
Current Version：v1
Current Pointer：`.pragma/design-contexts/issue-102/current.json`
Current Manifest：`.pragma/design-contexts/issue-102/versions/v1/manifest.json`
Package Path：`.pragma/design-contexts/issue-102/versions/v1/`
Package URL：如超过 20MB，补充 `s3://product-project-dev-lab/<object-key>` locator
Checksum：sha256:...
Context PR：!123
Merged Commit：abc123
```

### 6.4 不应放进开发 Issue 本体的内容

以下内容进入 Design Issue 或 Pragma Design Context Package，不进入开发 Issue body：

- 节点树；
- 详细尺寸；
- 全量样式；
- 截图；
- 切图素材；
- 组件状态；
- 动态区域定义；
- 设计意图长说明；
- 大段 Agent context。

---

## 7. 核心用户流程

### 7.1 PRD / 飞书讨论 intake

```text
1. Codex 读取飞书 PRD、飞书群讨论、会议纪要或客户反馈。
2. Codex 生成一批 Gitea 开发 Issue。
3. 对需要设计交付的开发 Issue，标记“需要 Design Issue：是”。
4. 同时生成对应 Design Issue，初始状态为待设计 / 待生成 Pragma Context。
5. 建立依赖关系：开发 Issue depends on Design Issue。
6. 对不需要设计交付的开发 Issue，标记“需要 Design Issue：否”，Pragma 不介入。
```

### 7.2 设计师生成上下文包

```text
1. 设计师根据 Design Issue 完成 Figma 设计。
2. 如当前流程需要，设计师通过蓝湖交付给人类查看。
3. 设计师在 Figma Plugin / Capture Bridge 中上传本次 page frame；components frame 和 assets frame 可选。
4. 如果 components/assets 本次未选择，默认复用 repo 中该 Figma fileKey 的 latest shared snapshot，并在本 Issue package 中锁定具体版本。
5. 如果页面内存在组件实例但没有可用 components snapshot，或存在未解析切图引用但没有可用 assets snapshot，采集应阻塞并提示补充。
6. Capture Bridge 负责解析 Figma URL、采集目标 frame、截图、素材、节点树、组件实例、变量和依赖锁，生成 Pragma 可 ingest 的输入目录。
7. Pragma 程序接收采集输出，而不是让开发 Agent 临时处理 Figma MCP 底层细节。
8. Pragma 保存 source 原始输出，并生成 normalized/agent-context.md、agent-workflow.md、design-context.json、pixel-spec/、layers/、components.json、assets.json、dependencies.json。
9. Pragma 将本次设计发布为 `.pragma/design-contexts/issue-102/versions/v1/`，并更新 `.pragma/design-contexts/issue-102/current.json` 指向 v1。
10. 设计师 Agent / 通用 Git 工具把 `.pragma` 变更提交到设计分支，例如 `design/issue-102-v1`，并开 PR 到 repo 默认分支。
11. 如果 context 超过 20MB，Pragma 发布完整 context.zip 到公司 MinIO，repo 内只保留可恢复的轻量入口和索引。
12. 设计 PR 合入默认分支后，通用 Issue 写入工具回填 Design Issue 的 current pointer、manifest、版本、checksum、PR 和 merged commit。
13. Design Issue 按通用 Issue 工作流进入 ready/done，关联开发 Issue 解除设计阻塞。
```

### 7.3 Runner 准备 / Codex Agent 消费上下文

```text
1. Codex 自动化读取开发 Issue。
2. 如果“需要 Design Issue：否”，不读取 Pragma，直接按开发 Issue 实现。
3. 如果“需要 Design Issue：是”，Governance / Design Gate 检查 dependency 中的同 repo Design Issue、merged Context PR、current pointer、manifest 和 checksum。
4. 如果 Design Issue 未完成或 package 不可恢复，在启动 Codex app-server turn 前停止并提示阻塞。
5. Runner 从包含设计 PR 的默认分支创建 workspace，并 pin source commit；in-flight turn 不再追随之后的 current.json 更新。
6. Runner 原生读取 current.json 和 manifest，校验 repo、Design Issue、linked Dev Issue、version、checksum 和 required entrypoints，不调用 Pragma CLI。
7. `<=20MB` 包直接使用 workspace 版本目录；MinIO 大包由隔离的 pre-dispatch materializer 下载、校验并以只读路径挂载。
8. Runner 生成 `pragma-context-descriptor/v1`，再启动或恢复 Codex app-server turn。
9. Codex Agent 从 descriptor 读取 manifest、normalized/agent-context.md 和 normalized/agent-workflow.md。
10. 读取 normalized/pixel-spec/index.json 作为页面 frame 下每个实现节点和组件实例位置的主规范。
11. 读取 normalized/dependencies.json，锁定本包使用的 components/assets snapshot 版本。
12. 按需读取 assets.json、tokens.json、components.json、render-instructions.md。
13. source/figma-get-design-context.md 只作为 fallback/source evidence。
14. 使用 screenshots/* 和 validation/visual-baseline.json 做视觉对比。
15. 实现 PR 必须记录本次消费的 Design Issue、source commit、Pragma version、manifest path 和 checksum。
```

开发者电脑、Codex app-server 和开发 Agent 不安装或调用 Pragma CLI，也不获取 MinIO credential。`pragma design read` 只保留为生产 pipeline smoke-check 和人工排障入口。

### 7.4 人类验收

```text
1. PR 提供预览地址或实现截图。
2. 设计师 / 产品 / 前端打开蓝湖、Figma 原稿、Pragma 轻量索引和实现预览。
3. 人类判断是否通过。
4. 不通过时，在 PR request changes 或新建/追加 Gitea Issue。
5. 问题重新进入 Issue loop。
```

Pragma 不作为设计验收裁判，只提供上下文和证据。

---

## 8. Design Context Package 设计

### 8.1 包设计原则

MVP 当前可以交付“设计上下文索引 + 粗到中等精度实现辅助”。如果要稳定支撑开发 Agent 做像素级还原，不能只依赖 `normalized/agent-context.md` 或 `source/figma-get-design-context.md` 的原始文本，必须增加机器可校验的 normalized pixel spec。

```text
Figma Plugin / MCP capture
-> source/figma-get-design-context.md           原始输出，source evidence
-> normalized/agent-context.md                  Agent briefing + package map
-> normalized/agent-workflow.md                 Agent 消费 workflow 与安全约束
-> normalized/design-context.json               任务级索引、frames、page regions、dynamic regions
-> normalized/pixel-spec/index.json             像素规范入口与分片索引
-> normalized/pixel-spec/frames/*.json          frame 级像素事实分片
-> normalized/pixel-spec/regions/*.json         page region 级像素事实分片
-> normalized/layers/index.json                 轻量图层树入口与分片索引
-> normalized/layers/frames/*.tree.json         frame 级轻量图层树
-> normalized/dependencies.json                 components/assets shared snapshot 依赖锁
-> normalized/assets.json + assets/             素材清单、绑定和实际素材
```

原则：

```text
1. Facts are generated by tools：bounds、style、asset binding、checksum、screenshot baseline 等事实由工具生成。
2. Narrative can be enriched by agents：设计摘要、实现提示、意图说明可由 Agent/LLM 增强，但必须标注来源。
3. Implementation is done by agents：开发 Agent 根据 Issue + normalized specs 实现代码。
4. ingest 不依赖 LLM：Pragma ingest 只做事实归一化、索引、checksum 和 schema 生成。
5. enrichment 是可选后处理：LLM enrichment 不得覆盖 machine facts，也不得混入事实归一化。
6. source/figma-get-design-context.md 只作为 fallback/source evidence，不作为唯一实现 IR。
7. 大素材、截图、SVG、PNG 不进入 agent-context.md，只通过相对路径、asset id 和 binding 引用。
8. 只有和本 Issue 有关的 frame、组件、状态、素材进入包，不打包整个 Figma 文件。
9. 页面 package 必须锁定所依赖的 components/assets snapshot，不能依赖浮动 latest。
10. components/assets frame 可被重复上传；相同内容生成同一个 content-addressed snapshot，避免每个 Issue 重复维护整棵组件库。
11. Codex 大模型只负责判断意图和补充说明；URL 解析、节点树采集、资产格式识别、UTF-8 编码、路径规范化等底层细节由确定性工具完成。
12. normalized 层每类事实只能有一个 canonical owner；其他文件只能引用、索引或作为 source evidence，避免 pixel-spec/layers/assets 互相复制。
```

#### 8.1.1 Normalized canonical ownership

| 事实类型 | Canonical owner | 其他文件如何引用 |
|---|---|---|
| 当前版本指针 | `current.json` | 只保存 current version / manifest path，不保存像素事实 |
| package 入口、版本、artifact URL | `versions/vN/manifest.json` | 其他文件不重复 package 元信息 |
| Agent briefing、read order、包地图 | `normalized/agent-context.md` | 不承载像素事实 |
| Agent 执行 workflow、安全约束、阻断规则 | `normalized/agent-workflow.md` | 不承载像素事实，只约束读取和实现流程 |
| 页面/Issue 摘要、frames、page regions、dynamicRegions | `normalized/design-context.json` | 不承载节点级 bounds/style；page region 只保存 id/ref/role/来源摘要 |
| 图层树、parent/children、source order | `normalized/layers/index.json` + `normalized/layers/frames/*.tree.json` | 只保留轻量树，不重复 style/text/asset placement |
| 节点级像素实现事实 | `normalized/pixel-spec/index.json` + `normalized/pixel-spec/frames/*.json` + `normalized/pixel-spec/regions/*.json` | 通过 `layerRef` / `figmaNodeId` 指向 layers；按 frame / page region 渐进式披露 |
| token 目录和 resolved value | `normalized/tokens.json` | pixel spec 使用 `tokenId + resolvedValue` 引用 |
| 组件实例索引和 snapshot refs | `normalized/components.json` | pixel spec 只写 componentRef，不复制组件定义 |
| package 依赖锁 | `normalized/dependencies.json` | manifest / issue-fragment 只引用 |
| asset 文件元数据 | `normalized/assets.json` | pixel spec 保存 placement/binding；assets 只保留 usedByNodeIds |
| 视觉基准与 diff 策略 | `validation/visual-baseline.json` | screenshots 只存文件 |
| 原始工具输出 | `source/*` | 只作 evidence / fallback，不作为 normalized contract |

实现要求：如果某字段已经有 canonical owner，其他 normalized 文件不得再保存完整副本；最多保存 id、path、ref 或摘要。

### 8.2 版本化包目录结构

Pragma context 在 repo 中按 Design Issue 聚合，并按版本不可变保存。`current.json` 是可变指针，开发 Agent 默认读取它；`versions/vN/` 是不可变事实目录，PR / 实现记录必须 pin 到具体版本和 checksum。

```text
.pragma/design-contexts/issue-123/
  current.json
  versions/
    v1/
      manifest.json
      source/
        figma-get-design-context.md
        figma-metadata.json
        figma-selection.json
      normalized/
        agent-context.md
        agent-workflow.md
        design-context.json
        pixel-spec/
          index.json
          frames/
            frame-main.json
          regions/
            top-filter-bar.json
            left-warning-panel.json
        layers/
          index.json
          frames/
            frame-main.tree.json
        tokens.json
        components.json
        dependencies.json
        assets.json
        render-instructions.md
      assets/
        icons/
          drone.svg
          warning.svg
        images/
          empty-state@2x.png
          panel-bg.webp
      screenshots/
        main-frame.webp
        popup-state.webp
        empty-state.webp
      handoff/
        README.md
        links.json
      validation/
        visual-baseline.json
      checksums.json
    v2/
      manifest.json
      normalized/
      ...
```

兼容要求：试点旧包可继续保留 `normalized/pixel-spec.json` 和 `normalized/layers.json` 聚合文件；新包的 canonical entrypoint 必须是 `normalized/pixel-spec/index.json` 和 `normalized/layers/index.json`。如果同时生成聚合文件，validate 必须保证它只是分片事实的派生视图，不得与分片事实冲突。

### 8.3 repo 中保留的上下文目录

repo 默认分支是稳定恢复来源。设计分支只作为生成 context 的临时工作分支；Design Issue 的最终产物必须通过 PR 合入默认分支，开发分支通过从默认分支创建或 rebase / merge 默认分支获得 `.pragma` 包。

MVP 约定：20MB 以内提交完整 Pragma context 版本目录；超过 20MB 时，repo 保留 Agent 读取入口和轻量索引，完整 `context.zip` 发布到公司 MinIO。

```text
.pragma/design-contexts/issue-123/
  current.json
  versions/
    v1/
      manifest.json
      normalized/
        agent-context.md
        agent-workflow.md
        design-context.json
        pixel-spec/
          index.json
          frames/*.json
          regions/*.json
        layers/
          index.json
          frames/*.tree.json
        tokens.json
        components.json
        dependencies.json
        assets.json
        render-instructions.md
      source/
        figma-get-design-context.md
        figma-metadata.json
      screenshots/
        main-frame.webp
      assets/
        ...
      handoff/
        README.md
      validation/
        visual-baseline.json
      checksums.json
```

同时 repo 应维护设计源共享快照目录，用于长期复用页面之外的 components/assets：

```text
.pragma/design-sources/figma/<fileKey>/
  registry.json
  sources.json
  snapshots/
    components-<nodeId>-<sha256>/
      capture.json
      normalized/components.json
      normalized/tokens.json
      screenshots/
      checksums.json
    assets-<nodeId>-<sha256>/
      capture.json
      normalized/assets.json
      assets/
      checksums.json
```

`registry.json` 保存每个 frame role 的 latest snapshot 指针和历史版本；Issue package 只能引用具体 snapshot id，不能引用 latest。这样每次新需求只需要上传 page frame；components/assets frame 如未选择则复用上次快照，如有变化则生成新快照并更新 registry。

当完整包超过 20MB 时，repo 中仍应保留 `current.json`、当前版本的 `manifest.json`、`normalized/agent-context.md`、`normalized/agent-workflow.md`、`normalized/pixel-spec/index.json`、`normalized/design-context.json`、`normalized/dependencies.json`、`normalized/assets.json`、`validation/visual-baseline.json` 和必要缩略图；`manifest.artifact` 以 bucket/objectKey/checksum 指向 MinIO 中的完整包。必要的 region/frame 分片应保留在 repo 或能通过 manifest artifact 恢复。

---

## 9. current.json 与 manifest.json 规格

`current.json` 是 Design Issue 的当前版本指针，位于 `.pragma/design-contexts/issue-<n>/current.json`。它是可变文件，不进入版本目录 checksum，也不作为开发 PR 的唯一引用依据。

示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-design-context-current",
  "designIssue": {
    "provider": "gitea",
    "repo": "example/repo",
    "number": 123
  },
  "currentVersion": "v1",
  "currentManifest": "versions/v1/manifest.json",
  "updatedAt": "2026-07-09T10:00:00+08:00",
  "updatedBy": "pragma design publish",
  "reason": "designer-published-new-context"
}
```

`manifest.json` 是具体版本目录的入口，位于 `.pragma/design-contexts/issue-<n>/versions/vN/manifest.json`。版本目录应尽量不可变；`status: current / superseded / outdated` 这类会变化的状态不写入 manifest，而由 `current.json`、Issue 评论、PR 检查或通用 Issue 工具判断。

示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-design-context-package",
  "id": "design-issue-123-v1",
  "version": "v1",
  "versionNumber": 1,
  "supersedes": null,
  "changeSummary": "Initial design context for issue #123.",
  "sourceChecksum": "sha256:...",
  "packageChecksum": "sha256:...",
  "issue": {
    "provider": "gitea",
    "repo": "example/repo",
    "number": 123,
    "type": "design"
  },
  "linkedDevelopmentIssues": [101],
  "compatibility": {
    "breakingChange": false,
    "requiresDevIssueReview": false,
    "reason": "initial version"
  },
  "source": {
    "provider": "figma",
    "adapter": "figma-mcp",
    "fileKey": "xxx",
    "nodes": ["1:23", "1:45"],
    "capturedAt": "2026-07-06T10:00:00+08:00"
  },
  "entrypoints": {
    "humanHandoff": "handoff/README.md",
    "lanhuUrl": "https://lanhuapp.com/xxx",
    "agentContext": "normalized/agent-context.md",
    "agentWorkflow": "normalized/agent-workflow.md",
    "designContext": "normalized/design-context.json",
    "pixelSpec": "normalized/pixel-spec/index.json",
    "layers": "normalized/layers/index.json",
    "tokens": "normalized/tokens.json",
    "components": "normalized/components.json",
    "dependencies": "normalized/dependencies.json",
    "assetsManifest": "normalized/assets.json",
    "renderInstructions": "normalized/render-instructions.md",
    "visualBaseline": "validation/visual-baseline.json",
    "sourceDesignContext": "source/figma-get-design-context.md",
    "assetsDir": "assets/",
    "screenshots": "screenshots/"
  },
  "artifact": {
    "storage": "repo",
    "owner": "example-org",
    "fileName": null,
    "checksum": "sha256:..."
  }
}
```

---

## 10. agent-context.md 规格

`agent-context.md` 的定位是 Agent briefing + package map，不是像素实现规范。它应帮助 Codex Agent 快速理解任务、包入口、阅读顺序、动态区域和注意事项，但不承载完整 bounds/style/layer tree。

当前 CLI 模板生成的 `agent-context.md` 主要是目录索引和设计摘要：source、issue、frame、screenshots、assets、notes、raw context 路径等。它不能单独支撑像素级实现。

建议结构：

```markdown
# Design Context for Issue #123

## Required Read Order
1. current.json（仅在需要解析当前版本时）
2. versions/vN/manifest.json
3. normalized/agent-context.md
4. normalized/agent-workflow.md
5. normalized/design-context.json，先确定本 Issue 涉及的 page regions
6. normalized/pixel-spec/index.json，只按 region/frame 索引读取必要分片
7. normalized/dependencies.json
8. normalized/assets.json
9. normalized/tokens.json
10. normalized/components.json
11. source/figma-get-design-context.md only as fallback/source evidence
12. screenshots/* and validation/visual-baseline.json for visual comparison

## Source
- Provider: Figma Plugin / Capture Bridge
- File: xxx
- Nodes: 1:23, 1:45
- Captured at: 2026-07-06T10:00:00+08:00

## Design Intent
- 本次要实现什么
- 哪些区域表达设计意图
- 哪些区域允许前端按真实服务实现

## Screens / Frames
- 主 frame 截图路径
- 目标 viewport
- 页面/弹窗/状态列表

## Implementation Structure
- 页面主要区域
- 关键节点层级
- Agent 推荐的实现结构

## Components
- Figma 组件/实例名
- MVP 不要求维护代码组件映射；如设计师有明确复用建议，可作为文字提示
- variants / states / props 提示

## Layout Essentials
- 只列关键尺寸、间距、固定/自适应规则
- 不列每个节点的所有坐标

## Styles / Tokens
- 只列本 Issue 必须遵守的颜色、字体、字号、圆角、阴影、状态色
- 如果已有 token 或 CSS 变量，给出映射

## Assets
- asset id
- 用途
- 相对路径
- 尺寸

## Implementation Notes
- 动态区域
- 不做范围
- 地图/图表/实时数据等特殊实现说明

## Agent Enrichment
- 可选
- generatedBy/model/timestamp 必须显式记录
- 不得覆盖 machine facts
```

---

## 11. normalized schema 规格

### 11.1 design-context.json

`design-context.json` 面向工具读取，只做任务级结构化索引：frames、pageRegions、dynamicRegions、主要入口文件。它不是像素实现规范，不承载节点级 bounds/style/text。

#### 11.1.1 Page Region 定义

Page Region 是 **page frame 上的实现区域**，来源于 page frame 下的可见元素、组件实例、frame/group 或设计工具 section；它不是要求设计师额外维护的新 Figma 对象，也不等同于代码组件名。

Page Region 的生成原则：

```text
- 只从本 Issue 选择的 page frame 内生成；components/assets frame 不直接生成业务 page region；
- 优先使用 page frame 的一级/二级可见 frame、component instance、section 作为候选；
- 对 repeated card/list/table 等结构，可以生成父 region，并把重复 item 作为 childRegion 或 patternRefs；
- 对地图、图表、视频、三维、实时数据等区域，生成 page region，同时在 dynamicRegions 中标记 pixelMatchRequired=false；
- region 可以带 role / semanticLabel / confidence，但这些只是语义提示，不是代码 selector；
- 如果 Figma 命名不规范，region 仍可由几何结构、文本标题、组件实例和层级推断生成，低置信度必须标记 confidence；
- Pragma 不维护“Semantic Regions”第二套概念；语义信息作为 pageRegions[] 的可选字段存在，避免 region 与 semantic region 两套索引分裂。
```

建议包含：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-design-context",
  "id": "design-context-issue-123-v1",
  "summary": "低空监控地图页面 UI 实现上下文",
  "source": {
    "provider": "figma",
    "fileKey": "xxx",
    "nodes": ["1:23", "1:45"]
  },
  "frames": [
    {
      "id": "frame-main",
      "figmaNodeId": "1:23",
      "name": "地图监控页",
      "viewport": { "width": 1920, "height": 1080 },
      "screenshot": "screenshots/main-frame.webp",
      "pixelSpec": "normalized/pixel-spec/frames/frame-main.json",
      "layerTree": "normalized/layers/frames/frame-main.tree.json"
    }
  ],
  "pageRegions": [
    {
      "id": "region-top-filter-bar",
      "frameId": "frame-main",
      "name": "顶部筛选栏",
      "role": "filter-bar",
      "semanticLabel": "筛选条件区域",
      "source": "page-frame-component-instance",
      "figmaNodeIds": ["1:24"],
      "pixelSpec": "normalized/pixel-spec/regions/region-top-filter-bar.json",
      "layerRefs": ["layer-1-24"],
      "implementationPriority": "required",
      "confidence": 0.96
    },
    {
      "id": "region-map",
      "frameId": "frame-main",
      "name": "地图底图",
      "role": "dynamic-map",
      "source": "page-frame-element",
      "figmaNodeIds": ["1:88"],
      "pixelSpec": "normalized/pixel-spec/regions/region-map.json",
      "implementationPriority": "intent-only",
      "confidence": 0.9
    }
  ],
  "dynamicRegions": [
    {
      "id": "region-map",
      "rule": "implementation-defined",
      "notes": "以真实地图服务渲染结果为准，设计稿只表达页面结构和控件位置。"
    }
  ],
  "assetsManifest": "normalized/assets.json",
  "dependencies": "normalized/dependencies.json",
  "pixelSpec": "normalized/pixel-spec/index.json",
  "layers": "normalized/layers/index.json",
  "agentContext": "normalized/agent-context.md",
  "agentWorkflow": "normalized/agent-workflow.md"
}
```

`sections` 作为旧字段可以保留为 `pageRegions` 的兼容别名，但新包必须写 `pageRegions`。

### 11.2 pixel-spec/ 渐进式像素规范

`normalized/pixel-spec/` 是开发 Agent 的主要像素实现入口，用于把 Figma capture 里的可实现节点转成稳定、可校验、可渐进式读取的 normalized contract。新包必须以 `normalized/pixel-spec/index.json` 作为入口，并按 frame 和 page region 输出分片；旧的 `normalized/pixel-spec.json` 聚合文件只允许作为兼容派生物。

入口文件示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-pixel-spec-index",
  "id": "design-context-issue-123-v1",
  "viewport": { "width": 1920, "height": 1080, "deviceScale": 1 },
  "frames": [
    {
      "id": "frame-main",
      "figmaNodeId": "1:23",
      "path": "normalized/pixel-spec/frames/frame-main.json",
      "layerTree": "normalized/layers/frames/frame-main.tree.json",
      "regionIds": ["region-top-filter-bar", "region-map"],
      "nodeCount": 126,
      "textNodeCount": 32
    }
  ],
  "regions": [
    {
      "id": "region-top-filter-bar",
      "frameId": "frame-main",
      "name": "顶部筛选栏",
      "role": "filter-bar",
      "path": "normalized/pixel-spec/regions/region-top-filter-bar.json",
      "nodeCount": 18,
      "textNodeCount": 5,
      "requiredForPixelMatch": true
    },
    {
      "id": "region-map",
      "frameId": "frame-main",
      "name": "地图底图",
      "role": "dynamic-map",
      "path": "normalized/pixel-spec/regions/region-map.json",
      "nodeCount": 12,
      "textNodeCount": 0,
      "requiredForPixelMatch": false,
      "dynamicRegionId": "region-map"
    }
  ],
  "dynamicRegions": [
    {
      "id": "region-map",
      "type": "map",
      "regionId": "region-map",
      "rendering": "implementation-defined",
      "pixelMatchRequired": false
    }
  ]
}
```

region/frame 分片示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-pixel-spec-region",
  "id": "region-top-filter-bar",
  "contextId": "design-context-issue-123-v1",
  "frameId": "frame-main",
  "figmaNodeIds": ["1:24"],
  "coordinateSpace": "frame",
  "bounds": { "x": 24, "y": 96, "width": 520, "height": 56 },
  "nodes": [
    {
      "id": "node-top-filter",
      "figmaNodeId": "1:24",
      "layerRef": "layer-1-24",
      "name": "顶部筛选栏",
      "type": "frame",
      "zIndex": 10,
      "bounds": { "x": 24, "y": 96, "width": 520, "height": 56 },
      "layout": {
        "mode": "horizontal",
        "position": "absolute",
        "constraints": { "horizontal": "left", "vertical": "top" },
        "overflow": "visible",
        "gap": 12,
        "padding": { "top": 8, "right": 12, "bottom": 8, "left": 12 }
      },
      "fills": [
        { "type": "solid", "tokenId": "color-panel-bg", "resolvedValue": "#0B1620", "opacity": 0.92 }
      ],
      "strokes": [
        { "tokenId": "color-panel-border", "resolvedValue": "#2A5D77", "width": 1, "position": "inside" }
      ],
      "radius": {
        "tokenId": "radius-panel",
        "resolvedValue": { "topLeft": 8, "topRight": 8, "bottomRight": 8, "bottomLeft": 8 }
      },
      "shadow": [
        { "tokenId": "shadow-panel", "resolvedValue": { "x": 0, "y": 8, "blur": 24, "spread": 0, "color": "rgba(0,0,0,0.24)" } }
      ],
      "opacity": 1,
      "blendMode": "normal",
      "text": null,
      "assetBinding": null,
      "componentRef": {
        "source": "figma",
        "instanceNodeId": "1:24",
        "componentId": "component-filter-bar",
        "mainComponentNodeId": "5:100",
        "variant": { "size": "default" },
        "definitionPath": ".pragma/design-sources/figma/xxx/snapshots/components-5-100-a1b2c3/normalized/components.json"
      },
      "state": "default"
    },
    {
      "id": "node-filter-label",
      "figmaNodeId": "1:25",
      "layerRef": "layer-1-25",
      "name": "筛选标题",
      "type": "text",
      "zIndex": 11,
      "bounds": { "x": 36, "y": 112, "width": 96, "height": 24 },
      "layout": { "position": "absolute" },
      "text": {
        "content": "区域筛选",
        "fontFamily": "Source Han Sans SC",
        "fontWeight": 500,
        "fontSize": 16,
        "lineHeight": 24,
        "letterSpacing": 0,
        "align": "left",
        "color": { "tokenId": "color-text-primary", "resolvedValue": "#E8F6FF" }
      },
      "fills": [],
      "strokes": [],
      "radius": null,
      "shadow": [],
      "opacity": 1,
      "blendMode": "normal",
      "assetBinding": null
    }
  ],
  "assetBindings": [
    {
      "nodeId": "node-bg-image",
      "assetId": "asset-panel-bg",
      "fit": "cover",
      "crop": { "x": 0, "y": 0, "width": 1, "height": 1 },
      "placement": { "x": 0, "y": 0, "width": 400, "height": 240 }
    }
  ],
  "availableStates": [
    { "name": "default", "source": "figma-node-state", "nodeIds": ["node-top-filter"] }
  ]
}
```

pixel spec 分片至少要表达：

- viewport / coordinateSpace：width、height、device scale、坐标空间；
- nodes：id、figmaNodeId、layerRef、name、type、zIndex、bounds；
- layout：position、flex/auto-layout、constraints、overflow、gap、padding；
- text：content、font family、weight、size、lineHeight、letterSpacing、align、color/fill，颜色应支持 `tokenId + resolvedValue`；
- fills、strokes、radius、shadow、opacity、blend，能映射 token 时必须写 `tokenId + resolvedValue`；
- asset binding：assetId、fit、crop、placement、nodeId；
- componentRef：组件实例 node、main component、variant/state、依赖 snapshot definitionPath；
- availableStates：来自 Figma 原生事实的可用状态，例如 component variants/properties、visible/hidden 节点、单独状态 frame；不承载 Issue 里才定义的业务运行默认态；
- dynamic regions：map、chart、realtime-data、video、3D 等标记为 implementation-defined，不强求像素还原。

pixel spec 不应保存完整 layer tree；树结构由 `normalized/layers/` 负责。需要表达树关系时使用 `layerRef` 指向 layers 分片。开发 Agent 不应对整个包执行宽泛 `rg fontSize`；必须先从 `design-context.json.pageRegions` 和 `pixel-spec/index.json` 定位相关 region，再读取对应分片。

### 11.3 layers/ 轻量图层树

`normalized/layers/` 保存实现相关的轻量 Figma layer tree / outline。它的职责是树导航和 source order，不是像素实现；不得重复 pixel spec 分片中的 style、text、asset binding，也不重复完整 bounds。

入口文件示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-layer-tree-index",
  "rootNodeIds": ["layer-1-23"],
  "frames": [
    {
      "id": "frame-main",
      "rootLayerId": "layer-1-23",
      "path": "normalized/layers/frames/frame-main.tree.json",
      "nodeCount": 126
    }
  ]
}
```

frame tree 分片示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-layer-tree-frame",
  "frameId": "frame-main",
  "rootNodeIds": ["layer-1-23"],
  "nodes": [
    {
      "id": "layer-1-23",
      "figmaNodeId": "1:23",
      "normalizedNodeId": "node-1-23",
      "name": "地图监控页",
      "type": "FRAME",
      "parentId": null,
      "children": ["layer-1-24", "layer-1-25"],
      "sourceOrder": 0,
      "renderable": true,
      "sectionId": "section-main",
      "pageRegionId": "region-top-filter-bar"
    }
  ]
}
```

允许保留的字段：

- `id`、`figmaNodeId`、`normalizedNodeId`；
- `name`、`type`、`parentId`、`children`、`sourceOrder`；
- `renderable`、`hidden`、`locked`、`sectionId`、`role`、`pageRegionId` 等轻量语义。

不允许重复的字段：

- `bounds`、`layout`、`fills`、`strokes`、`radius`、`shadow`；
- `text`、`assetBinding`、`asset placement`；
- 完整 `componentRef` 定义。

如果 tree 调试确实需要尺寸概览，只允许写入可选 `boundsRef: "normalized/pixel-spec/regions/<region>.json#node-..."` 或 `boundsRef: "normalized/pixel-spec/frames/<frame>.json#node-..."`，不内联 bounds。

### 11.4 tokens.json

`tokens.json` 保存规范化设计 token，不只是 source variables。至少覆盖颜色、字体、字号、行高、间距、圆角、阴影，并记录 source variable/style id。

### 11.5 components.json

`components.json` 保存页面 package 内出现的组件实例索引，以及本包锁定的 shared components snapshot 中的 component set、variants、states。Code Connect 映射如果存在可以记录；MVP 不要求人工维护映射，也不能因缺少 Code Connect 阻塞 package 生成。

建议最小结构：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-components",
  "instances": [
    {
      "nodeId": "node-top-filter",
      "figmaNodeId": "1:24",
      "name": "筛选栏 / 当前在飞",
      "mainComponentNodeId": "5:100",
      "componentSetId": "component-filter-bar",
      "variant": { "state": "active", "size": "default" },
      "pixelNodeId": "node-top-filter",
      "layerRef": "layer-1-24",
      "definitionSource": ".pragma/design-sources/figma/xxx/snapshots/components-5-100-a1b2c3"
    }
  ],
  "componentSets": [
    {
      "id": "component-filter-bar",
      "name": "筛选栏",
      "source": "shared-snapshot",
      "snapshotId": "components-5-100-a1b2c3",
      "variants": [
        { "props": { "state": "active", "size": "default" }, "nodeId": "5:101" }
      ]
    }
  ],
  "codeConnect": []
}
```

页面 frame 下的每个组件实例位置必须写入对应 pixel spec frame/region 分片的 `nodes[].bounds`。`components.json.instances[]` 只保存组件实例索引和定义来源，通过 `pixelNodeId` / `layerRef` 指向位置事实，不重复 bounds。完整组件库定义不强行塞进页面 package；应通过 `dependencies.json` 锁定 shared components snapshot。

### 11.6 dependencies.json

`dependencies.json` 记录本 Issue package 对共享 components/assets snapshots 的锁定关系，解决“每次页面上传都会重复带上全量组件 frame / 切图 frame”的长期维护问题。

建议结构：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-design-dependencies",
  "fileKey": "xxx",
  "capturedAt": "2026-07-07T10:00:00+08:00",
  "pageFrames": [
    { "nodeId": "1:23", "name": "app-首页", "snapshotId": "page-1-23-d4e5f6" }
  ],
  "components": {
    "status": "selected | reused | missing | none",
    "frameNodeId": "5:100",
    "frameNodeIds": ["5:100", "5:101"],
    "snapshotId": "components-5-100-a1b2c3",
    "path": ".pragma/design-sources/figma/xxx/snapshots/components-5-100-a1b2c3",
    "checksum": "sha256:..."
  },
  "assets": {
    "status": "selected | reused | missing | none",
    "frameNodeId": "6:200",
    "frameNodeIds": ["6:200", "6:201"],
    "snapshotId": "assets-6-200-f7g8h9",
    "path": ".pragma/design-sources/figma/xxx/snapshots/assets-6-200-f7g8h9",
    "checksum": "sha256:..."
  },
  "rules": {
    "lockDependencies": true,
    "neverDependOnFloatingLatest": true,
    "ifMissingComponentsAndPageHasInstances": "block",
    "ifMissingAssetsAndPageHasUnresolvedRefs": "block"
  }
}
```

`status` 语义：

- `selected`: one or more components/assets frames were selected in this upload; the bridge/core must generate or hit a snapshot from the normalized content for that role. `frameNodeId` is kept as a first-frame compatibility field; `frameNodeIds` records the full selected frame list.
- `reused`：本次未选择，但复用了 registry 中的 latest snapshot，并锁定为具体 snapshot id；
- `missing`：本次未选择且 registry 中没有可用快照；若页面有组件实例或未解析素材引用，应阻塞；
- `none`：页面明确不依赖共享 components/assets。

`dependency-lock.json` materialization / reconcile 规则：

```text
- `selected` components/assets 不允许只写“将来应该存在”的 snapshot path；最终进入 ingest/pack 前必须已经 materialize 到 `.pragma/design-sources/figma/<fileKey>/snapshots/<snapshotId>/`。
- 如果 Capture Bridge / Plugin 已经选择了 components/assets frame，但还没有生成 snapshot，`preflight --fix` 或 `pack-from-figma-capture` 必须先执行 source sync，按该 role 的规范化内容生成或命中 snapshot。
- source sync 完成后必须回写 `dependency-lock.json` 中的 concrete `snapshotId`、`path`、`checksum`，并保证 path 指向真实存在的 snapshot 目录。
- 如果 selected frame 的原始数据不足以 materialize snapshot，返回 `BLOCKING_DEPENDENCY_SNAPSHOT_MISSING`，提示补采 components/assets frame，而不是让 validate 在末端才发现 path missing。
- `reused` 只能引用 registry 中已存在的 concrete snapshot；禁止把 latest 字符串或 latest 路径写入 Issue package。
```

### 11.7 render-instructions.md

`render-instructions.md` 面向开发 Agent，提供强约束实现说明：

- 哪些 page regions 必须像素还原；
- 哪些 page regions 可用真实服务实现；
- 哪些素材必须使用；
- 哪些样式应映射到项目 token；
- 哪些区域不在本 Issue 范围内。

`render-instructions.md` 不负责指定业务运行默认态；如果某个默认态、选中态、弹层打开态需要在实现中出现，应由开发 Issue 或验收标准说明。

### 11.8 agent-workflow.md

`agent-workflow.md` 是开发 Agent 的消费流程和安全约束。它必须随 package 生成，并在 `agent-context.md` read order 中排在 `design-context.json` 和 pixel spec 分片之前。

最小内容必须包含：

```markdown
# Agent Workflow

## Read Gate
1. Resolve current.json when no explicit version is pinned.
2. Read versions/vN/manifest.json.
3. Read normalized/agent-context.md.
4. Read normalized/agent-workflow.md.
5. Read normalized/design-context.json and identify relevant pageRegions.
6. Read normalized/pixel-spec/index.json, then only the needed frame/region shards.
7. For every modified UI region, consume bounds, typography, fills/strokes/radius/shadow, asset bindings, and availableStates.

## Typography
- For every changed text node, use the font family, fontWeight, fontSize, lineHeight, letterSpacing, and color from the relevant pixel spec frame/region shard.
- Do not preserve existing application font sizes just because the current CSS cascade wins; if a design value cannot be applied safely, report the cascade conflict.

## Progressive Disclosure Rules
- Do not run broad text searches across the whole context package before selecting relevant pageRegions.
- Do not infer typography from screenshots when pixel spec text facts are available.
- Do not read source/figma-get-design-context.md as the primary implementation contract.

## State Responsibility
- Pragma provides available design states captured from Figma facts.
- The development Issue owns which runtime state should be implemented or displayed by default.
- If the design screenshot shows sample selected/open/filled data but the Issue does not require it, treat it as visual sample only.

## Business Data Safety
- Do not add fake runtime data, fallback records, selected items, or open popovers to production business components solely for visual parity.
- If visual parity requires sample data or forced UI state, stop and ask the user whether to add a preview-only/dev-only path or adjust the Issue requirement.

## CSS Strategy
- Prefer scoped component/page styles over global tail overrides.
- If an existing CSS cascade prevents safe changes, report it and propose either a scoped override file or a component refactor.
- Tail-of-file override is allowed only as a short-term spike with explicit user approval, not as the default implementation strategy.
```

validate 应检查 `agent-workflow.md` 存在，并至少包含 Typography、Progressive Disclosure、Business Data Safety、CSS Strategy 四类约束。

---

## 12. assets.json 规格

`assets.json` 是 asset 文件元数据的 canonical owner，不内联二进制。它记录开发实现真正需要的素材文件：path、mime/type、真实像素尺寸、checksum、required、usedByNodeIds。asset-to-node 的 fit/crop/placement 不属于 `assets.json`，应由 `pixel-spec/index.json` 的 `assetBinding` / `assetBindings` 保存。

页面 frame 内直接用于开发实现的素材必须复制或引用到本 Issue package；仅作为视觉基准的 frame render 不应放入 `assets/`，只放入 `screenshots/` 并由 `validation/visual-baseline.json` 引用。来自共享“切图/assets frame”的素材应由 `dependencies.json` 锁定到具体 assets snapshot。采集侧必须通过文件 magic bytes / MIME sniff 校验真实格式，不能只相信扩展名；SVG、PNG、WebP、JPEG 的 path、mime、checksum 必须一致。

示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-design-assets",
  "assets": [
    {
      "id": "asset-drone-icon",
      "name": "无人机图标",
      "role": "map-marker",
      "type": "svg",
      "path": "assets/icons/drone.svg",
      "width": 32,
      "height": 32,
      "sourceNodeIds": ["1:88"],
      "usedByNodeIds": ["node-drone-marker"],
      "checksum": "sha256:...",
      "required": true
    },
    {
      "id": "asset-empty-state",
      "name": "空态插图",
      "role": "empty-state",
      "type": "webp",
      "path": "assets/images/empty-state@2x.webp",
      "width": 480,
      "height": 320,
      "sourceNodeIds": ["1:99"],
      "usedByNodeIds": ["node-empty-illustration"],
      "checksum": "sha256:...",
      "required": false
    }
  ]
}
```

### 12.1 validation/visual-baseline.json 规格

`visual-baseline.json` 记录可复现视觉基准，用于开发后截图比对和人工 review。Pragma 不做最终验收裁判，但应提供稳定基准。

示例：

```json
{
  "schemaVersion": "2.0",
  "kind": "pragma-visual-baseline",
  "viewports": [
    {
      "id": "desktop-1920",
      "width": 1920,
      "height": 1080,
      "deviceScale": 1,
      "baselineScreenshot": "screenshots/main-frame.webp",
      "diffThreshold": {
        "pixelRatio": 0.02,
        "ignoreRegions": ["region-map"],
        "warnOnlyRegions": ["region-chart"]
      }
    }
  ],
  "strategy": "screenshot-diff-for-reference",
  "humanReviewRequired": true
}
```

---

## 13. 大素材存储方案

### 13.1 最终方案

MVP 默认要求：Pragma context 归属于同一个 Gitea repo，并优先以 Git 文件提交到默认分支中的版本目录。

```text
<= 20MB：完整 context 版本目录提交到同 repo 的 `.pragma/design-contexts/issue-<design-issue>/versions/vN/`，并维护 current.json；不提交 context.zip。
> 20MB 且 <= 100MB：repo 保留轻量入口，完整 context.zip 发布到公司 MinIO。
> 100MB：不作为 MVP 常规路径，先拆分或减少素材。
MinIO endpoint 和凭据由部署环境注入，不写入 package 或 repo secret。
```

### 13.2 存储方案对比

| 方案 | 用途 | 是否默认 | 原因 |
|---|---|---|---|
| 普通 Git 文件 | 20MB 以内完整 context；超过 20MB 时保留 manifest、agent-context、索引、必要缩略图 | 默认 | 满足“上下文包在 repo 内”的要求，开发 Agent 可直接从 repo 读取 |
| 公司 MinIO | 超过 20MB 的完整 context.zip | 默认大包路径 | 已有后端，使用 bucket/prefix policy、不可变 object key 和 checksum 恢复，避免 repo 被大二进制拖慢 |
| Git LFS | 大素材 | 备选 | 需要服务端和开发机 LFS 配置 |
| Release / Issue 附件 | 临时人工上传 | 不推荐 | 自动化和版本化不如对象存储 |
| Gitea Generic Package Registry | 包存储 | 不使用 | 公司已统一使用 MinIO，避免维护第二套大包后端 |

### 13.3 包命名规范

repo 内默认路径：

```text
.pragma/design-contexts/issue-102/
  current.json
  versions/
    v1/
      manifest.json
      normalized/
      source/
      assets/
      screenshots/
      handoff/
```

如果包体超过 20MB，额外发布：

```text
bucket:      product-project-dev-lab
object key:  pragma-design-context/<owner>/<repo>/issue-102/v1/context.zip
locator:     s3://product-project-dev-lab/<object-key>
```

Endpoint 由部署配置提供，不写入 manifest 作为下载权威：

```text
PRAGMA_MINIO_ENDPOINT=http://218.11.1.13:9000
PRAGMA_MINIO_BUCKET=product-project-dev-lab
PRAGMA_MINIO_REGION=us-east-1
PRAGMA_MINIO_OBJECT_PREFIX=pragma-design-context
PRAGMA_MINIO_PUBLISH_ACCESS_KEY=<secret-manager / environment>
PRAGMA_MINIO_PUBLISH_SECRET_KEY=<secret-manager / environment>
PRAGMA_MINIO_VIEW_URL=http://218.11.1.13:9000/
```

Publisher 与 Governance Runner 使用不同 key pair；Runner 侧变量为 `PRAGMA_CONTEXT_MINIO_ACCESS_KEY` / `PRAGMA_CONTEXT_MINIO_SECRET_KEY`。Access Key、Secret Key、session token 或 presigned URL 均不得写入 PRD、manifest、Issue、日志或 Git。当前 endpoint 是 HTTP，只允许通过受控公司网络访问；生产优先启用 TLS 或受信代理终止 TLS。

### 13.4 大小分档

```text
轻量 / 常规上下文：<= 20MB
- 提交完整 context 版本目录到 repo，包括 manifest、agent-context.md、agent-workflow.md、design-context.json、pixel-spec/、layers/、tokens.json、components.json、assets.json、validation baseline、source 原始输出、必要截图和必要素材。
- 不提交 `context.zip`；如 CLI 生成 zip，只能作为临时 build artifact，并应进入 `.gitignore` 或临时输出目录。

较大上下文：20MB - 100MB
- 仍归属于同 repo。
- 完整 context.zip 发布到公司 MinIO。
- repo 保留 current.json、当前版本 manifest、agent-context.md、agent-workflow.md、design-context.json、pixel-spec/index.json、必要 pixel-spec 分片、assets.json、visual-baseline.json、素材缩略图或占位索引。
- `manifest.artifact` 记录 `storage: minio-s3`、bucket、确定性 objectKey、`s3://` locator、checksum 和 archive size。

超大完整包：> 100MB
- 不建议进入 MVP 常规流程。
- 需要拆分素材、减少截图，或由团队另行评估 Git LFS。
- 不引入第二套 Gitea Package Registry 存储路径。
```

### 13.5 版本规则

```text
1. Design Issue 的 Pragma context 按 versions/vN/ 不可变保存，不覆盖旧版本。
2. current.json 是可变指针，只表示当前推荐版本；开发 PR 必须记录自己实际消费的 vN 和 checksum。
3. 设计变更生成 v2、v3，不修改 v1 内容。
4. manifest 中不写 current / superseded / outdated 这类可变状态；这些状态由 current.json、Issue 评论、PR 检查或通用 Issue 工具判断。
5. 不要求迁移或保留 Pragma 1.0 旧上下文包。
```

### 13.6 Runner 侧解析与 MinIO 物化

开发消费不依赖 Pragma CLI。Governance Runner 在 app-server turn 启动前按 `pragma-integration/v1` 原生解析 package，并输出：

```json
{
  "schemaVersion": "pragma-context-descriptor/v1",
  "repo": "org/repo",
  "devIssue": 101,
  "designIssue": 102,
  "sourceCommit": "abc123",
  "currentPointer": ".pragma/design-contexts/issue-102/current.json",
  "manifestPath": ".pragma/design-contexts/issue-102/versions/v1/manifest.json",
  "version": "v1",
  "checksum": "sha256:...",
  "storage": "repo",
  "resolvedRoot": "/runner/context/issue-102/v1/sha256-...",
  "entrypoints": {},
  "readOrder": []
}
```

当 `manifest.artifact.storage` 是 `minio-s3` 时，Runner 的可信 pre-dispatch materializer 使用隔离的只读身份下载。artifact 写入 Git workspace 之外、按完整 SHA-256 digest 寻址的 cache；完成 bucket allowlist、确定性 objectKey、压缩/解压大小、文件数量、checksum、绝对路径、`../`、symlink/hardlink 校验后，才以只读路径交给 Agent。MinIO Access/Secret Key 不进入 app-server、Agent shell、hooks、prompt 或开发者电脑。

推荐 Git 流程：

```text
设计师 / Agent 生成 context
-> 提交到设计分支，例如 design/issue-102-v1
-> 打开 PR 到 repo 默认分支
-> PR merge 后，默认分支拥有 .pragma/design-contexts/issue-102/versions/v1
-> 通用 Issue 写入工具回填 Design Issue
-> Dev branch 从默认分支创建，或 rebase / merge 默认分支后读取 context
```

开发分支不直接依赖设计分支，也不从设计分支复制文件。Design Issue 的最终产物是已经合入默认分支的 `.pragma` 目录和可复现 manifest，而不是某个临时 branch。

---

## 14. 命令设计

### 14.1 MVP CLI

```text
pragma design prepare-figma-capture
确定性预处理命令：解析 Figma URL、校验 fileKey/nodeId、整理 page/components/assets frame 选择、读取/更新 shared source registry，并生成 Capture Bridge / Plugin 可执行的采集计划。

pragma design preflight --input <pragma-input> --repo <repo> [--fix] [--json]
对已有 Capture Bridge / Plugin 输出目录做确定性预检和可修复项修正；检查 UTF-8/JSON、asset checksum/尺寸/MIME、dependency snapshot 是否已 materialize，并在 `--fix` 下重算无效 checksum、修正文件像素尺寸、source sync selected components/assets snapshot、回写 `dependency-lock.json`。

pragma design from-figma
端到端便捷命令：调用 Capture Bridge 生成 pragma-input，再执行 preflight --fix -> source sync/reconcile -> ingest -> pack -> publish -> issue-fragment -> validate -> read smoke-check；适合设计师只提供目标 frame 链接的常用流程。

pragma design source add / source sync
维护 `.pragma/design-sources/figma/<fileKey>/` 下的 shared components/assets snapshots；相同内容按 checksum 复用，不生成重复版本。

pragma design ingest
接收 Figma Plugin / Capture Bridge 产出的采集目录或 JSON，生成 source/ 和 normalized machine facts；ingest 不依赖 LLM。

pragma design pack
校验并打包 manifest、source、normalized、assets、screenshots、validation、轻量 handoff 索引。

pragma design publish --issue <design-issue> [--version vN|--bump auto] [--supersedes vN] [--change-summary <file>]
将 pack 结果发布到 `.pragma/design-contexts/issue-<n>/versions/vN/`，更新 `.pragma/design-contexts/issue-<n>/current.json`；20MB 以内提交完整 context 版本目录且不保留 context.zip，超过 20MB 上传 context.zip 到公司 MinIO 并更新 manifest.artifact。Pragma 只写文件和 artifact，不直接创建 Git branch / PR。

pragma design issue-fragment --issue <design-issue> [--version current|vN]
生成 Design Issue 回填 markdown，包含 current pointer、manifest、package path / URL、version、checksum、context PR、merged commit 占位；实际写入、评论、状态流转和 dependency 创建由通用 Issue 写入工具完成，不由 Pragma 直接负责。

pragma design diff --issue <design-issue> --from v1 --to v2
输出两个版本的结构化差异摘要，供设计师、人类 reviewer 或通用 Issue 工具判断是否需要开发 Issue review；MVP 不让 Agent 自动猜测是否可以无视设计变更。

pragma design pack-from-figma-capture
兼容命令：从已有 Figma MCP capture 输入目录执行 preflight --fix -> source sync/reconcile selected snapshots -> ingest -> pack -> publish -> issue-fragment -> validate -> read smoke-check。长期推荐由 `from-figma` / Capture Bridge 统一处理 URL、三类 frame 和 shared snapshot。

pragma design enrich
可选 LLM enrichment 后处理，生成 normalized/agent-context.enriched.md 或 agent-context.md 中的 Agent Enrichment 区块；必须记录 generatedBy/model/timestamp，不得覆盖 machine facts。

pragma design read --issue <design-issue> [--version vN]
生产 pipeline smoke-check、人工排障和本地复现命令；默认读取 current.json 指向的当前版本，也允许读取指定 vN。命令输出必须包含 resolved version、manifest path 和 checksum。开发 Agent 的正常运行时由 Governance Runner 按文件协议解析，不依赖或调用该命令。

pragma design asset
按 asset id 获取具体素材文件。

pragma design validate
校验包结构、current.json、版本目录、manifest、schema、checksum、pixel-spec 引用、素材绑定、token 引用、截图基准和 package URL 是否完整。

pragma design validate --repo <repo> --source-registry [--file-key <fileKey>] [--json]
在现有 validate 基础上扩展 shared source registry 健康检查：校验 `.pragma/design-sources/figma/<fileKey>/registry.json`、`sources.json`、snapshots、latest 指针、snapshot checksum 和 Issue package dependency lock 的可恢复性；validate 仍只报告问题，不自动修复。

pragma design pack-latest-capture --repo <repo> --issue <number> [--input <pragma-input>] [--preflight-only] [--force] [--threshold-mb <mb>] [--json]
正式本体 CLI pipeline runner：自动定位目标 issue 在显式 `--repo` 下的最新 `pragma-input/`，或使用显式 `--input` 覆盖；执行 repo-scoped preflight/pack/validate/read smoke-check 并写入 `handoff/pipeline-summary.json`。该命令收敛本地 PowerShell wrapper 的试点能力，成为 Codex、人工和后续自动化调用的单一入口；自动发现不得扫描父目录、磁盘根目录或无关仓库。
```

### 14.2 设计师端示例

```text
1. 设计师提供本次 page frame 的 Figma 链接，或在 Figma Plugin 中选择 page frame。
2. Plugin / Capture Bridge 让用户选择三类 frame：page 必选，components 可选，assets 可选。
3. components/assets 未选择时，默认复用该 fileKey 下 registry 的 latest shared snapshot，并在本 Issue package 中锁定具体 snapshot id。
4. 如果没有可复用 snapshot 且页面存在组件实例或未解析素材引用，采集阻塞并提示补选 components/assets frame。
5. 推荐运行 `pragma design from-figma`；对已有 `pragma-input/` 运行 `pragma design pack-from-figma-capture`，内部必须先执行 preflight/reconcile。
6. publish 生成 `.pragma/design-contexts/issue-102/versions/v1/` 和 `current.json`。
7. 设计师 Agent / 通用 Git 工具提交设计分支并开 PR 到默认分支。
8. 设计 PR 合入后，通用 Issue 写入工具使用 markdown 回填 Design Issue #102。
```

### 14.3 Runner / Codex Agent 消费示例

```text
1. Governance 读取开发 Issue #101
2. 如果“需要 Design Issue：否”，直接启动 Codex turn，不读取 Pragma
3. 如果“需要 Design Issue：是”，追溯 dependency 中的 Design Issue #102，并要求 Design Gate ready
4. Runner checkout 包含设计 PR 的默认分支 commit；缺 package 时在 app-server 前阻断
5. Runner 读取 current.json / manifest，pin source commit、version 和 checksum
6. MinIO 大包由可信 materializer 写入 checksum-keyed cache，并只读挂载
7. Runner 生成 `pragma-context-descriptor/v1`，然后启动或恢复 Codex app-server turn
8. Agent 从 descriptor 读取 manifest.json、normalized/agent-context.md 和 normalized/agent-workflow.md
9. 读取 normalized/pixel-spec/index.json 作为像素实现主规范
10. 读取 normalized/dependencies.json 确认 components/assets snapshot 锁定版本
11. 按需读取 assets.json、tokens.json、components.json、render-instructions.md
12. source/figma-get-design-context.md 只作为 fallback/source evidence
13. 使用 screenshots/* 和 validation/visual-baseline.json 做视觉对比与人工 review
14. 实现代码并在 PR 记录 Design Issue、source commit、version、manifest path 和 checksum
```

该流程不要求开发者、app-server 或 Agent 安装 Pragma CLI。Agent 不自行下载 MinIO object，也不持有 MinIO credential。

### 14.4 本地 Pipeline Runner 与 wrapper 退役

MVP 需要把“找到最新 capture -> preflight --fix -> pack -> validate -> read smoke-check -> 输出回填信息”固化为一次可复跑操作，避免 Agent 每次临时拼接命令或扩大搜索范围。现在该能力应沉淀到本体 CLI：

```text
pragma design pack-latest-capture
```

CLI runner 职责：

```text
- 只在显式 `--repo` 的 `.pragma/incoming/figma-captures/issue-<number>-*/pragma-input/` 下按 issue 查找最新输入，不扫描父目录、无关项目、磁盘根目录或 node_modules；
- 支持显式 `--input <pragma-input>` 覆盖自动发现，但仍需校验输入目录存在、可读、且不会触发输出路径穿越；
- 在运行打包前校验 `pragma-input/` 必需文件和目录，必要时执行 `preflight --fix`；
- 默认通过 UTF-8 读写 JSON/Markdown，避免 Windows PowerShell 默认编码导致中文节点名和 Figma URL 被破坏；
- 支持 `--preflight-only` 快速确认输入是否可修复/可打包，且不写入最终 context；
- 完整模式执行 `pack-from-figma-capture`，随后强制 `validate` 和 `read --summary-only` 烟测；
- 已存在 context 时默认拒绝覆盖，只有显式 `--force` 才允许重跑；
- 在 `handoff/pipeline-summary.json` 写入 inputPath、contextDir、manifestPath、issueFragmentPath、artifact、preflight repairs、validation warnings、read smoke-check 路径和分阶段 timings；
- `--json` 输出结构化结果和结构化错误码，Agent 不需要解析自然语言日志。
```

示例：

```powershell
pragma design pack-latest-capture `
  --repo D:\path\to\repo `
  --issue 102 `
  --preflight-only `
  --json

pragma design pack-latest-capture `
  --repo D:\path\to\repo `
  --issue 102 `
  --force `
  --threshold-mb 20 `
  --json
```

`scripts/Invoke-PragmaCapturePipeline.ps1` 只保留为 Windows 本地兼容 shim，职责是把原有参数转译为 `pragma design pack-latest-capture` 并透传 stdout/stderr/exit code；它不得再拥有独立的 capture 查找、preflight、validate 或 summary 生成逻辑。长期维护源只能是 Node CLI。

---

## 15. 设计工具适配方案

### 15.1 Provider Adapter 架构

Pragma 2.0 应区分三层：

```text
capture/provider-specific      Figma Plugin / MCP / 设计工具 Bridge 的原始采集
source/provider-specific       Pragma 包内无损保存的 source evidence
normalized/provider-neutral    Pragma 标准上下文格式
```

当前 Figma：

```text
Figma URL / Plugin selection
-> Pragma Figma Capture Bridge
-> pragma-input/
-> source/figma-*.json / figma-get-design-context.md
-> normalized/pixel-spec/index.json / layers/index.json / components.json / assets.json / dependencies.json
-> Design Context Package
```

未来 Pencil、Penpot 或其他设计工具：

```text
Other Design Tool Bridge
-> pragma-input/
-> source/provider-*.json
-> normalized/provider-neutral specs
-> Design Context Package
```

开发侧 Agent 永远读取 `manifest.json`、`agent-context.md`、`pixel-spec/index.json`、`dependencies.json` 和其他 normalized 文件，不关心底层设计工具来源。

### 15.2 Pragma Figma Capture Bridge

长期方案是在现有 `pragma-input -> ingest -> pack` 之前增加一个薄的、确定性的 Figma Capture Bridge。它不替代现有架构，而是把 Codex 目前反复用大模型处理的底层细节固化为工具能力。

Capture Bridge 职责：

```text
- 解析 Figma URL，提取 fileKey、branchKey、nodeId，并规范化 nodeId 分隔符；
- 校验目标 node 是否存在、是否是 frame/section/component set 中可采集的类型；
- 调用 Figma MCP / Figma Plugin API 采集 metadata、node tree、bounds、style、component refs、variables、screenshots、assets；
- 根据 page/components/assets 三类 frame 生成采集计划；
- 维护 `.pragma/design-sources/figma/<fileKey>/registry.json` 和 shared snapshots；
- 生成 page package 的 dependencies lock；
- 对截图、SVG、PNG、WebP、JPEG 做 MIME sniff、checksum、尺寸探测；
- 统一 UTF-8、路径分隔符、文件名 slug、JSON schema、错误码；
- 输出稳定的 `pragma-input/`，供现有 ingest 消费。
```

Tested behavior note: `Send to local bridge` does not auto-start a local service. Designers or agents must explicitly run the local Node bridge first. Development plugins may only call `http://localhost:48732`; before sending, the plugin should call `/health`. `Failed to fetch` means the bridge is not running, the host/port does not match, or manifest network permissions do not match; it is not a capture-content error.

Capture Bridge 不做的事：

```text
- 不用 LLM 推断 bounds/style/component tree；
- 不把 React/Tailwind reference code 当作机器事实；
- 不替代 Pragma ingest / pack / publish；
- 不负责开发 Issue 写入；
- 不把全量 Figma 文件或无关页面打进 package。
```

### 15.3 Figma Plugin 三类 frame 上传模型

Figma Plugin / Capture Bridge 每次上传要求用户按角色选择 frame：

```json
{
  "slots": {
    "page": {
      "required": true,
      "multiple": true,
      "mode": "persistent-slot",
      "description": "Implementation page, modal, or state frames. Current Figma selection is only an add-to-slot source; changing selection must not clear existing slots."
    },
    "components": {
      "required": false,
      "multiple": true,
      "default": "reuse-latest-snapshot",
      "ifMissingAndPageHasInstances": "block",
      "description": "Reusable component sheets such as App Mobile / Components. If omitted, bridge/core resolves registry latest."
    },
    "assets": {
      "required": false,
      "multiple": true,
      "default": "reuse-latest-snapshot",
      "ifMissingAndPageHasUnresolvedAssetRefs": "block",
      "description": "Asset boards or export frames. If omitted, bridge/core resolves registry latest."
    }
  },
  "selectionBehavior": "current-selection-adds-to-slot-without-clearing-existing-slots",
  "fileKey": {
    "required": true,
    "fallbackOrder": ["fileKeyOverride", "figmaUrl", "figma.fileKey"],
    "ifMissing": "block-before-export-or-send"
  },
  "localBridge": {
    "requiredForSend": true,
    "captureUrl": "http://localhost:48732/capture",
    "healthUrl": "http://localhost:48732/health"
  },
  "lockDependencies": true,
  "neverDependOnFloatingLatest": true
}
```

三类 frame 的产物：

| Frame role | 是否必选 | 产物 | 未选择时 |
|---|---:|---|---|
| page | 是 | Issue package：`pixel-spec/index.json`、`layers/index.json`、页面截图、页面内素材绑定 | 阻塞 |
| components | 否 | Shared components snapshot：组件定义、variants、states、tokens、截图 | 复用 latest snapshot；无可用 snapshot 且页面有实例则阻塞 |
| assets | 否 | Shared assets snapshot：切图素材、asset manifest、checksum、尺寸和 MIME | 复用 latest snapshot；无可用 snapshot 且页面有未解析素材则阻塞 |

状态语义必须写入 `normalized/dependencies.json`：`selected`、`reused`、`missing`、`none`。

### 15.4 目标 frame 与组件实例采集粒度

Figma MCP 的基本读取单位是 node/frame，而不是“每个 component 必须单独调用一次”。对页面实现而言，默认策略是：

```text
1. 对 page frame 调用一次主采集，获得该 frame 下的 layer tree、bounds、文本、样式、素材绑定和 component instance refs。
2. page package 的 `pixel-spec/index.json` 必须包含页面 frame 下每个实现节点的位置；组件实例也要有 bounds、zIndex、layout 和 state/variant。
3. 对 components frame / component set 只在需要完整定义、variants、states 或组件总表发生变化时采集。
4. 不为页面里的每个 component instance 单独调用 Figma MCP；除非主采集缺少某个 main component definition，才按需补采该 component node。
5. 页面 package 不应塞入完整组件库；它只保存页面中用到的 instance facts，并通过 `dependencies.json` 锁定 shared components snapshot。
```

因此，如果用户只提供一个 app 首页 frame，正常 package 应包含首页 frame 下所有实现节点和组件实例的位置；如果还希望 Agent 读到完整组件定义，则需要选择 components frame，或复用之前已上传的 components snapshot。

### 15.5 共享 components/assets snapshot 与依赖树

每个 Figma fileKey 在 repo 内维护一个共享设计源目录：

```text
.pragma/design-sources/figma/<fileKey>/
  registry.json
  sources.json
  snapshots/
    components-<frameNodeId>-<contentSha>/
    assets-<frameNodeId>-<contentSha>/
```

`registry.json` 示例：

```json
{
  "schemaVersion": "2.0",
  "fileKey": "xxx",
  "latest": {
    "components": "components-5-100-a1b2c3",
    "assets": "assets-6-200-f7g8h9"
  },
  "roles": {
    "components": [
      {
        "snapshotId": "components-5-100-a1b2c3",
        "frameNodeId": "5:100",
        "name": "App Mobile / Components",
        "checksum": "sha256:...",
        "capturedAt": "2026-07-07T10:00:00+08:00"
      }
    ],
    "assets": [
      {
        "snapshotId": "assets-6-200-f7g8h9",
        "frameNodeId": "6:200",
        "name": "切图",
        "checksum": "sha256:...",
        "capturedAt": "2026-07-07T10:00:00+08:00"
      }
    ]
  }
}
```

编排规则：

```text
- page package 永远锁定具体 snapshot id，不读取 floating latest；
- 新上传 components/assets frame 时，按规范化内容 hash 去重；hash 相同则复用已有 snapshot；
- page/components/assets content hashes must be computed per role from that role frame content and related assets. Do not hash the whole pragma-input for every role, or unrelated roles may get the same checksum/snapshot suffix.
- hash 不同则生成新 snapshot，并把 registry latest 指向新版本；
- 已生成的历史 Issue package 不随 registry latest 改变；
- 如果页面 frame 指向的 component main node 在 locked snapshot 中不存在，validate 报 blocker 或要求补采；
- 如果页面素材引用在 locked assets snapshot 中不存在，validate 报 blocker 或要求补采。
```

### 15.6 assets frame 与页面资产规则

页面资产分两类：

```text
page-bound assets：页面 frame 内直接出现并必须随 Issue package 使用的素材，例如当前页面背景、局部图标、插画。
shared assets：切图 frame / assets frame 中维护的可复用素材，例如通用 tab 图标、地图 marker、状态图标。
```

规则：

- page-bound assets 必须进入当前 Issue package 的 `assets/` 和 `normalized/assets.json`；
- shared assets 进入 `.pragma/design-sources/figma/<fileKey>/snapshots/assets-*`，Issue package 通过 `dependencies.json` 锁定；
- 如果 assets frame 未选择，则默认复用 latest assets snapshot；
- 如果没有 latest snapshot 且页面存在 unresolved asset refs，采集阻塞；
- MIME、扩展名、checksum、尺寸必须由工具探测，不让 Codex 临时判断。

素材尺寸和 checksum 语义：

```text
- `assets-manifest.json` / `normalized/assets.json` 中的 `width`、`height` 表示实际素材文件像素尺寸，由 PNG/WebP/JPEG/SVG sniff 得出；
- 设计稿中的放置尺寸、裁剪区域和缩放规则只写入 `source/asset-bindings.json` 和 `normalized/pixel-spec/index.json` 的 asset binding；不得写入 `normalized/assets.json`；
- 导出文件像素尺寸与 Figma placement 尺寸可以不同，validate 只用 asset.width / height 对比真实文件尺寸；
- checksum 只有匹配 `sha256:[0-9a-f]{64}` 时才被视为可信；`sha256:plugin-webcrypto-unavailable-*`、空值或其他占位值都视为 checksum unavailable；
- checksum unavailable 时 Capture Bridge 应省略 checksum 或写 `checksumStatus: "unavailable"`，不得写伪 sha256；`preflight --fix` 必须根据实际文件重算 checksum 并写回。
```

### 15.7 Windows / 编码 / 资产格式的应用级治理

为减少 Codex 在 Windows 上反复处理编码和资产小坑，Pragma 应提供统一的 deterministic runtime：

```text
- 不在 shell 中拼接长 Python/Node 脚本；需要复杂逻辑时生成临时脚本文件并记录日志；
- 所有 JSON/Markdown/source text 默认 UTF-8，无 BOM 或统一 BOM 策略，并在 validate 中检测 mojibake；
- PowerShell 输出、Python stdout、Node stdout 显式设置 UTF-8；
- 文件路径内部统一 POSIX-style relative path，写入磁盘时再转换为本地路径；
- 严禁路径穿越，所有输出必须落在 repo `.pragma/` 或指定 output root 内；
- 资产按 magic bytes / MIME sniff 校验真实格式，必要时自动修正扩展名；
- 删除/覆盖只允许在 Pragma 管理的 package/snapshot 目录内执行，并先校验 resolved absolute path；
- 所有命令支持 `--json` 输出结构化错误码，避免 Agent 解析自然语言日志。
- Pragma CLI 的自动发现仍必须限制在显式 `--repo` 的 `.pragma/` 管理目录内，不允许从父目录、磁盘根目录、无关项目或 node_modules 递归扫描；默认排除 node_modules、dist、build、.git、大型 sourcemap 和二进制目录。
- 常用本地流程必须沉淀为仓库脚本或 CLI 子命令，并输出 summary/log；不得把一次性 shell 搜索、临时修复和上下文打包逻辑散落在 Codex prompt 中。
- Figma development plugin local bridge calls use only `http://localhost:48732/capture` and `http://localhost:48732/health`; do not put `127.0.0.1` in manifest allowedDomains.
- Bridge errors return structured JSON, for example `{ "ok": false, "error": "...", "hint": "..." }`; plugin UI must expand object errors instead of showing `[object Object]`.
```

这部分应作为 Pragma CLI / Capture Bridge 的公共库，而不是散落在 Codex prompt 或每次临时脚本里。

#### 15.7.1 Preflight / repair pipeline

`pragma design preflight --input <pragma-input> --repo <repo> [--fix] [--json]` 是已有 capture 输入进入 ingest/pack 前的确定性闸口。它面向“Plugin / Capture Bridge 已经产出目录，但输入还可能有小坑”的场景，把可机器修复的问题固化为 CLI 行为，而不是让 Agent 手工排障。

preflight 至少检查：

```text
- `capture.json`、`dependency-lock.json`、`assets-manifest.json`、`asset-bindings.json`、`figma/*.json` 是否为 UTF-8 可读 JSON；
- 必需目录和文件是否存在：figma/、screenshots/、assets/、designer-notes.md、dynamic-regions.md；
- selected/reused components/assets snapshot 的 path 是否存在，checksum 是否为真实 sha256；
- selected components/assets frame 已在本次 input 中提供时，是否可以 materialize shared snapshot；
- asset path 是否存在，扩展名/MIME/magic bytes 是否一致；
- asset checksum 是否缺失、占位或不匹配实际文件；
- asset width/height 是否等于实际文件像素尺寸；
- asset bindings 的 figmaNodeId / nodeId 是否能在 layers 或 pixel spec 输入事实中解析；
- Figma URL、fileKey、nodeId、frame role 是否在 capture、metadata、selection、dependency-lock 中一致。
```

`--fix` 只允许执行确定性、可复验的修复：

```text
- 重算缺失、占位或不匹配的 asset checksum；
- 用真实文件像素尺寸覆盖 asset.width / asset.height；
- 对 selected components/assets 执行 source sync，生成或命中 concrete snapshot；
- 将 concrete snapshotId/path/checksum 回写到 dependency-lock；
- 规范化路径分隔符、去除 UTF-8 BOM、补齐空的 notes 文件；
- 生成 machine-readable repair report，不覆盖设计语义事实。
```

preflight 输出的错误分三类，供 Agent 和 UI 直接决策：

```text
AUTO_FIXABLE
- placeholder or invalid asset checksum
- asset file dimension mismatch
- selected snapshot missing but selected frame data is present
- UTF-8 BOM or path separator normalization

BLOCKING_INPUT
- invalid JSON
- missing capture.json / issue number / required directories
- asset file referenced by manifest is missing
- selected snapshot missing and selected frame data is absent

BLOCKING_DESIGN
- page has component instances but no components snapshot/frame
- page has unresolved asset refs but no assets snapshot/frame
- required dynamic/non-pixel region notes are absent for map/chart/video/3D nodes
```

`pack-from-figma-capture` 和 `from-figma` 必须默认调用 preflight；`validate` 是末端一致性检查，不负责修改输入。

#### 15.7.2 Pipeline tracing

`preflight`、`pack-from-figma-capture`、`from-figma` 和本地 wrapper 必须输出机器可读的分阶段耗时，用来区分 Pragma CLI 性能问题、capture 输入规模问题和 Agent 外部操作问题。

建议最小字段：

```json
{
  "timings": {
    "resolveInputMs": 12,
    "preflightMs": 190,
    "ingestMs": 610,
    "packZipMs": 420,
    "publishMs": 80,
    "issueFragmentMs": 20,
    "validateMs": 250,
    "readSmokeCheckMs": 260
  },
  "preflightSummary": {
    "repairs": 2,
    "unresolved": 0
  }
}
```

`assets.json` 不应保存：

- `fit`、`crop`、`placement`；
- screenshot baseline；
- Figma frame render 预览图；
- 没有被当前 Issue package 或 locked shared snapshot 使用的素材。

这些信息的 owner：

- fit/crop/placement：`normalized/pixel-spec/index.json`；
- 视觉基准截图：`screenshots/` + `validation/visual-baseline.json`；
- 原始采集素材清单：`source/assets-manifest.json`。

完整 pipeline 应将同一份摘要写入 `handoff/pipeline-summary.json`，并在 CLI JSON 输出中返回该文件路径。Figma Plugin / Capture Bridge 可补充 capture 侧 timings，例如 serialize、export screenshots、export assets、write files、dependency lock。

试点反馈：

```text
- 本地 issue-3 capture 中，真正 `preflight --fix` 约 0.2s，完整 pack/validate/read 约 2-3s；
- 如果“preflight 阶段”明显超过数秒，应先确认是否是 Agent 在 CLI 外做了过宽文件搜索、终端输出过大或扫描 node_modules，而不是 preflight 自身耗时；
- pipeline wrapper 必须记录各阶段耗时到 `handoff/pipeline-summary.json`，用于区分 CLI 性能问题、输入规模问题和 Agent 操作问题；
- checksum unavailable / placeholder 是正常可修复输入问题，必须由 preflight 重算真实 sha256 并写回；不应让 Agent 手工编辑 manifest。
```

### 15.8 Figma Capture 输入输出契约

#### 15.8.1 Capture 输入

设计师端 Plugin / Codex / CLI 至少接收：

```json
{
  "repo": {
    "owner": "org",
    "name": "product-repo",
    "localPath": "D:/path/to/repo"
  },
  "designIssue": {
    "number": 102,
    "title": "Design context handoff"
  },
  "targetDevIssues": [
    { "number": 101, "title": "Implement the page" }
  ],
  "figma": {
    "fileKey": "Resolved from fileKey override, Figma URL, or figma.fileKey; block if missing",
    "frames": {
      "page": [
        { "nodeId": "1:23", "name": "app-home", "url": "https://www.figma.com/design/xxx/File?node-id=1-23" }
      ],
      "components": [
        { "nodeId": "5:100", "name": "App Mobile / Components", "url": "https://www.figma.com/design/xxx/File?node-id=5-100", "optional": true }
      ],
      "assets": [
        { "nodeId": "6:200", "name": "assets", "url": "https://www.figma.com/design/xxx/File?node-id=6-200", "optional": true }
      ]
    }
  },
  "blueLakeUrl": "optional",
  "designerNotes": "Optional: intent, priority, implementation boundaries",
  "dynamicRegionNotes": "Optional: map, chart, 3D, video, or realtime-data implementation notes"
}
```

Capture 输入不接收“业务运行默认态”作为 Pragma 事实。设计稿可以包含多个可用视觉状态，开发 Issue 负责说明本次实现需要展示或默认进入哪个业务运行态。

#### 15.8.2 Capture 输出目录

Capture Bridge 将 Figma 输出整理为 Pragma 输入目录：

```text
pragma-input/
  capture.json
  dependency-lock.json
  figma/
    metadata.json
    selection.json
    get-design-context.md
    layers.json
    variables.json
    components.json
  screenshots/
    main-frame.webp
    state-empty.webp
    state-error.webp
  assets/
    icons/
    images/
    exports/
  assets-manifest.json
  asset-bindings.json
  designer-notes.md
  dynamic-regions.md
```

其中：

- `capture.json`：采集任务元信息，包括 repo、issue、capturedAt、source provider、Figma URL、frame roles、skill/bridge 版本；
- `dependency-lock.json`: records page/components/assets snapshot status, snapshot id, checksum, path, and blocking rules. Selected components/assets support `frameNodeIds` for multiple frames; `frameNodeId` is only a first-frame compatibility field. Before ingest/pack, selected/reused snapshot refs must be concrete, materialized, and checksum-verified; otherwise preflight must repair or block.
- `figma/metadata.json`：来自 Figma metadata 的文件、页面、节点、类型、尺寸、更新时间、component/variant/property、visibility 等原生事实；
- `figma/selection.json`: records the captured page/components/assets frame lists so agents do not read the whole Figma file. Each frame should include nodeId, name, role, size, and a reproducible Figma frame URL.
- `figma/get-design-context.md`：保留 Figma MCP `get_design_context` 原始输出，作为 source evidence 和 fallback，不作为唯一实现 IR；
- `figma/layers.json`：实现相关节点树、bounds、children、component refs、component properties、variant properties、visibility；
- `figma/variables.json`：颜色、字体、spacing、radius 等 variables/styles/token 原始事实；
- `figma/components.json`：本次页面用到的组件实例，以及 shared snapshot 中的 component set、variant properties、component properties、available states、Code Connect 映射（如有）；
- `screenshots/`：主 frame、关键状态、弹窗、空状态、错误态等视觉参照；
- `assets/`：仅导出开发需要的切图、图标、背景、插画，不导出整份设计文件；
- `assets-manifest.json`：素材 id、文件名、用途、实际文件像素尺寸、格式、导出倍率、是否必须使用；设计放置尺寸不写在这里，写入 asset bindings placement；
- `asset-bindings.json`：素材与 Figma node / normalized node 的绑定关系，包括 fit、crop、placement；
- `designer-notes.md`：设计师补充的意图、优先级、实现边界；
- `dynamic-regions.md`：地图、图表、视频、三维、实时数据等“不以设计稿像素为准”的区域说明。

#### 15.8.3 必采信息

MVP 第一版可以保留 Figma `get_design_context` 原始输出，但为了支持更稳定的实现，capture 应尽量输出可归一化为 pixel spec 的机器事实：

```text
必须采集：
- fileKey、fileName、pageName、nodeId、nodeName、nodeType、frame role；
- page frame 的宽高、布局方向、主要约束；
- page frame 下每个可实现节点的 node id、name、type、bounds、zIndex、children；
- 可实现文本内容、字体、字号、字重、行高、letterSpacing、颜色；
- fills、strokes、radius、shadow、opacity、blend、constraints、auto-layout；
- component instance refs、main component id、component set、variant properties、component properties、visibility/hidden 状态；
- page-bound asset binding、shared asset refs、fit、crop、placement；
- Figma 原生可用状态：组件 variants/properties、单独状态 frame、visible/hidden 节点；prototype interactions 和 pluginData 不作为 MVP 必采事实；
- get_design_context 原始输出；
- 关键截图；
- 必要素材、素材索引和 asset-to-node binding；
- variables/styles，并尽量归一化为 tokens；
- 动态区域说明和设计师备注；
- Figma URL、capturedAt、source checksum、snapshot checksum。

可选采集：
- prototype link；
- pluginData / sharedPluginData；
- 蓝湖链接；
- 设计注释；
- Code Connect 映射。

不采集：
- 全量 Figma 文件；
- 全量历史版本；
- 与本 Issue 无关的页面和组件；
- Figma token 或访问凭证。
```

MVP 不强依赖 Code Connect / 代码组件映射；如果 capture 能拿到映射，可以保存到 `normalized/components.json`，但缺失时不阻塞 package 生成。

### 15.9 Pragma ingest 输出

Pragma 执行 `pragma design ingest` 后，将输入目录转换为一个版本目录的标准内容；`publish` 再把它放入 `.pragma/design-contexts/issue-<n>/versions/vN/` 并更新 `current.json`：

```text
source/
  capture.json
  dependency-lock.json
  figma-metadata.json
  figma-selection.json
  figma-get-design-context.md
  figma-layers.json
  figma-variables.json
  figma-components.json
normalized/
  agent-context.md
  agent-workflow.md
  design-context.json
  pixel-spec/index.json
  layers/index.json
  tokens.json
  components.json
  dependencies.json
  assets.json
  render-instructions.md
screenshots/
assets/
validation/
  visual-baseline.json
manifest.json
checksums.json
handoff/README.md
```

`source/` 尽量无损保存采集事实，`normalized/` 负责让开发 Agent 快速读取和可校验实现。`ingest` 的 normalized machine facts 不依赖 LLM。

---

## 16. 蓝湖保留策略

MVP 阶段继续保留蓝湖：

```text
Pragma 服务 Agent：提供结构化设计上下文、素材 manifest、设计意图、动态区域说明。
蓝湖服务人类：继续承担尺寸查看、切图下载、标注查看和人工兜底开发。
Design Issue 连接两者：同时引用 Pragma context 和蓝湖交付链接。
```

Pragma 不在 MVP 阶段重做蓝湖 Inspect 页面，只生成轻量索引文件，方便人类知道本次 Issue 对应哪些设计源、截图、素材和说明。

---

## 17. 权限与安全

### 17.1 权限边界

```text
设计师端：
- 需要 Figma Plugin / MCP / 设计工具 Bridge 的采集权限。
- 负责生成 Pragma Design Context Package。

开发人员 / Codex Agent：
- 不需要 Figma Plugin / MCP 权限。
- 需要 repo 读取权限。
- 不安装或调用 Pragma CLI。
- 不持有 MinIO read/publish credential；超过 20MB 的包由 Runner pre-dispatch materializer 使用隔离只读身份恢复。

Governance Runner / materializer：
- Runner 从 pinned commit 原生读取 current.json / manifest 并生成无 secret descriptor。
- materializer 可以获得仅用于本次恢复的只读 MinIO credential，但 credential 必须在 app-server 启动前移除。
- app-server、Agent shell、repo hooks 和 prompt 均不得继承 MinIO credential。
```

### 17.2 包内容安全

Design Context Package 不应包含：

- Figma token；
- 设计工具访问凭证；
- 用户隐私数据；
- 客户敏感数据；
- Agent 不需要的全量设计文件。

### 17.3 校验要求

`pragma design validate` 至少校验以下内容。validate 是末端 guard，只报告一致性问题，不重写输入；checksum、尺寸、snapshot materialization 等可自动修复项应在 preflight 阶段完成。

- manifest schema 合法；
- `current.json` 指向的 `versions/vN/manifest.json` 存在；
- 版本目录不覆盖旧版本，且 `manifest.version`、目录名、package checksum 一致；
- `agent-context.md` 存在；
- `agent-workflow.md` 存在，且包含 progressive disclosure、typography、business data safety、CSS strategy 约束；
- `design-context.json` 存在，且新包必须包含 `pageRegions`；
- `normalized/pixel-spec/index.json` 存在，且 frame/region 分片引用、viewport、dynamicRegions 基本结构合法；如果存在 legacy `normalized/pixel-spec.json`，必须与分片派生事实一致；
- `normalized/layers/index.json` 及 frame tree 分片中的 root/node 引用可解析；
- layers 分片不内联 bounds/style/text/asset placement；如出现这些字段，validate 报 warning 或 blocker，要求使用 pixel spec 分片作为 canonical owner；
- `tokens.json` 中被 pixel spec 引用的 tokenId 存在；
- pixel spec 分片中可映射 token 的 color/radius/shadow/typography 应包含 `tokenId + resolvedValue`；缺少 tokenId 可 warning，但不得缺少 resolvedValue；
- `components.json` 中被 pixel spec 引用的 componentRef 存在或被标记为 external/optional；
- `components.json.instances[]` 不重复 bounds；组件实例位置以 pixel spec frame/region 分片的 `nodes[].bounds` 为准；
- `dependencies.json` 存在，且 page/components/assets snapshot status、checksum、path 合法；
- Issue package 不引用 floating latest，只引用具体 snapshot id；
- page frame 下的 component instance 在 locked components snapshot 中可解析，或被显式标记为 external/optional；
- `assets.json` 中引用的素材存在；
- pixel spec 分片中引用的 assetId 都能在 `assets.json` 中找到；
- asset binding 的 nodeId / figmaNodeId 能在 pixel spec 分片或 layers 分片中找到；
- `assets.json` 不重复 fit/crop/placement；这些字段只能出现在 `pixel-spec/index.json` 的 asset binding 中；
- `assets/` 只包含开发实现需要的素材；仅用于视觉基准的 frame render 不得放入 `assets/`，应放入 `screenshots/`；
- asset 文件的扩展名、MIME、magic bytes、实际文件像素尺寸和真实 sha256 checksum 一致，且不接受 placeholder checksum；
- source/normalized Markdown 和 JSON 为 UTF-8，且不出现明显 mojibake；
- Figma URL 解析出的 fileKey/nodeId 与 source metadata、selection 和 manifest 一致；
- `validation/visual-baseline.json` 存在，且引用的 screenshot 文件存在；
- 如存在 `context.zip`，checksum 与 manifest 一致；
- 当 context <= 20MB 且完整目录提交 repo 时，不应提交 `context.zip`；validate 可提示将 zip 作为临时 artifact 或加入 ignore；
- Pragma 2.0 package version 不覆盖旧版本；
- 不要求迁移或保留 Pragma 1.0 旧上下文包；
- 如 context 超过 20MB，MinIO bucket/objectKey 可由只读身份访问且 checksum 一致。

开发后验证建议：

- 开发 Agent 或 CI 可以截取实现截图；
- 使用 `validation/visual-baseline.json` 中的 viewport、baseline screenshot、ignoreRegions、diffThreshold 做 screenshot diff；
- Pragma 输出可复现基准和校验结果，但不作为设计验收或视觉 CI 的最终裁判；
- 设计师 / 产品 / 前端仍通过 PR review、蓝湖/Figma 和实现预览完成最终人类验收。

---

## 18. 成功指标

### 18.1 MVP 验收标准

一个 Pragma 2.0 MVP 可认为成功，如果它满足：

```text
1. PRD / 飞书讨论 intake 可以为需要设计交付的开发 Issue 自动创建对应 Design Issue。
2. 设计师端 Figma Plugin / Capture Bridge 可以让用户选择 page/components/assets 三类 frame，并生成 Pragma 可 ingest 的输入目录。
3. components/assets 未选择时可以复用 latest shared snapshot，并在 Issue package 中锁定具体 snapshot id；缺少必要 snapshot 时能明确阻塞。
4. Pragma context 可以写入同一个 Gitea repo；<=20MB 提交完整版本目录且不提交 context.zip，>20MB 发布完整 context.zip 到公司 MinIO。
5. Design Issue 可以通过通用 Issue 写入工具从“待生成”回填 current pointer、Manifest、Package、版本、Checksum、PR 和 merged commit。
6. 开发 Issue 可以通过 Gitea dependency 依赖 Design Issue。
7. 开发人员没有 Figma 权限且不安装 Pragma CLI，也能由 Runner 从 repo 或 repo + MinIO 恢复上下文。
8. Runner 在 app-server 前输出 pin source commit/version/manifest/checksum 的 `pragma-context-descriptor/v1`；Codex Agent 按 descriptor/read order 读取 agent briefing、agent workflow、design-context pageRegions、pixel spec 分片、dependencies、assets、tokens、components、source evidence 和 screenshots。
9. 如果需要像素级还原，package 必须包含 `normalized/pixel-spec/index.json` 和必要的 frame/region 分片；只有 agent-context.md 或 raw get_design_context 不足以称为稳定像素规范。
10. 如果开发 Issue 需要 Design Issue 但依赖的 Design Issue 未交付、设计 PR 未合入默认分支或 package 无法物化，Runner 必须在启动 Codex turn 前停止并报告阻塞。
11. 前端开发人员继续使用蓝湖走人类兜底开发。
12. 设计变更可以重新生成 Pragma 2.0 新版本包，更新 current.json，并回填 Design Issue；Pragma 1.0 旧包不要求保留。
13. Pragma 不接管 Issue 生命周期，不强制视觉 CI，不替代人类验收，但提供可复现 visual baseline。
14. 开发者、Codex app-server、开发 Agent 和 repo hooks 均不依赖 Pragma CLI，也无法读取 MinIO credential。
```

### 18.2 过程指标

MVP 试点阶段可观察：

- 需要 Design Issue 的开发 Issue 中，Agent 是否能少问设计上下文问题；
- 前端是否减少手工向设计师索要素材和尺寸；
- context 包平均大小；
- context 包生成耗时；
- preflight repairs 数量、repair 类型和 unresolved blocker 数量；
- pipeline wrapper 成功率，以及 pack / validate / read smoke-check 分阶段耗时；
- context 包被 Agent 读取成功率；
- pixel-spec 覆盖率和 asset binding 完整率；
- page frame 下 component instance bounds 覆盖率；
- components/assets snapshot 复用率、去重率和依赖锁命中率；
- Windows/编码/资产格式类采集失败次数；
- screenshot diff 的可复现率；
- 因设计信息缺失导致的返工次数；
- 设计变更 v2 包的引用是否清晰可追溯。

---

## 19. 里程碑

### M0：Issue 模板与依赖约定

- 定义开发 Issue 中的设计输入段落；
- 定义 Design Issue 模板；
- 明确开发 Issue 的 `需要 Design Issue：是/否` 字段；
- 验证 Gitea issue dependency 是否启用；
- 明确 Codex Agent 遇到“需要 Design Issue：是”时必须追溯依赖 Issue。

### M1：上下文包规范

- 定义 manifest schema；
- 定义 agent-context.md 模板；
- 定义 agent-workflow.md、design-context.json、pixel-spec/index.json 与分片、layers/index.json 与分片、tokens.json、components.json、dependencies.json 和 assets.json 最小字段；
- 定义 normalized canonical ownership：layers 不重复 bounds/style/text/asset placement，assets 不重复 placement，components instances 不重复 bounds；
- 定义 visual-baseline.json 和 screenshot diff 基准；
- 定义目录结构和 checksum 规则。

### M2：Figma Capture Bridge / Plugin Contract

- 实现 Figma URL 解析、nodeId 规范化和目标 frame 校验；
- 实现 page/components/assets 三类 frame 选择 UI / 输入契约；
- 从 Figma MCP / Plugin API 获取 `get_design_context`、metadata、node tree、component refs、variables、截图和必要素材；
- 生成 Pragma 输入目录和 `dependency-lock.json`；
- 统一 UTF-8、路径规范、资产 MIME sniff、checksum 和结构化错误码；如果 checksum 不可用，省略 checksum 或标记 `checksumStatus: unavailable`，不得生成伪 sha256；
- 保存采集时间、Figma URL、nodeIds、frame roles 和蓝湖链接。

### M2.5：Shared Design Source Registry

- 在 `.pragma/design-sources/figma/<fileKey>/` 下维护 registry、sources 和 snapshots；
- 支持 components/assets snapshot 的 content hash 去重和 latest 指针；
- 支持未选择 components/assets 时复用 latest snapshot，并为 Issue package 锁定具体 snapshot id；
- 支持缺少必要 snapshot 时阻塞并给出补采建议；
- 支持 selected components/assets frame 自动 materialize snapshot，并把 concrete snapshotId/path/checksum 回写到 dependency lock；
- 校验历史 Issue package 不随 latest 改变。

### M3：Pragma ingest / pack

- 实现 `pragma design preflight --input --repo [--fix] [--json]`，并在 `from-figma` / `pack-from-figma-capture` 中默认调用；
- `pragma design ingest` 接收 Figma Plugin / Capture Bridge 输出；
- 保存 source 原始输出；
- 生成 `agent-context.md`、`pixel-spec/index.json`、`layers/index.json`、`tokens.json`、`components.json`、`dependencies.json`、`design-context.json`、`assets.json`；
- 在 `pixel-spec/index.json` 中写入 tokenId + resolvedValue 映射；`layers/index.json` 只生成轻量树；`assets.json` 只保留开发所需素材文件元数据；
- 生成 `validation/visual-baseline.json`；
- 仅在 >20MB 或明确发布 package 时生成 / 保留 context.zip；<=20MB 场景不把 context.zip 写入 repo；
- 校验 schema、checksum、dependency lock、asset binding、token/component 引用和 screenshot baseline。
- 提供正式 `pragma design pack-latest-capture` CLI pipeline runner，固定 repo-scoped `latest pragma-input` 查找、preflight-only、pack、validate、read smoke-check、覆盖保护和 `handoff/pipeline-summary.json` 阶段耗时输出；PowerShell wrapper 只作为兼容 shim。
- 为 preflight、pack-from-figma-capture、from-figma、validate、read smoke-check 输出分阶段 timings，并把 pipeline summary 写入 handoff。
- 在现有 `pragma design validate` 基础上扩展 shared source registry 校验：context validate 必须验证 locked snapshot path/checksum 可恢复，repo/source-registry validate 必须能单独检查 registry、sources、latest 和 snapshots 健康度。

### M4：repo 写入与 MinIO 发布

- 写入同 repo 的 `.pragma/design-contexts/issue-<n>/versions/vN/` 路径，并维护 `current.json`；
- <=20MB 提交完整 context 版本目录且不提交 context.zip；
- >20MB 上传 context.zip 到公司 MinIO；
- 如上传 package，生成 bucket/objectKey/`s3://` locator 并写入 `manifest.artifact`；
- 校验 repo 默认分支中 current.json、manifest、agent-context、pixel-spec、visual-baseline 和 MinIO object 可恢复。

### M5：Issue 引用与 Agent 读取

- 生成 Design Issue 回填 markdown 片段；
- 通用 Issue 写入工具消费该 markdown 并回填 Design Issue；
- Governance Runner 能在没有 Pragma CLI 时根据 Design Issue 原生解析 current.json 和 manifest，并输出 `pragma-context-descriptor/v1`；
- MinIO 大包通过隔离的 pre-dispatch materializer 写入 checksum-keyed cache，并只读交付给 Agent；
- `pragma design read` 保留为生产 smoke-check 和人工排障入口，不作为开发消费依赖；
- 开发 Agent 能从开发 Issue dependency 追溯到 Design Issue；
- Agent 按 read order 读取 `agent-context.md`、`agent-workflow.md`、`design-context.json`、`pixel-spec/index.json` 和必要分片、`dependencies.json`、`assets.json`、`tokens.json`、`components.json`、source evidence、screenshots 和具体素材。

### M6：试点验证

- 选择 1-2 个真实 UI Issue；
- 使用 Figma Plugin / Capture Bridge 生成 Pragma context；
- Codex Agent 使用 context 开发；
- 前端继续使用蓝湖兜底；
- 收集返工、信息缺失、包大小和 Agent 使用反馈。

---

## 20. 风险与应对

| 风险 | 说明 | 应对 |
|---|---|---|
| context 包过大 | 包含太多截图或素材 | 只打包 Issue 相关节点，素材按需导出 |
| 开发消费依赖 Pragma CLI | 开发机/Runner 安装与版本漂移导致任务不可移植 | 稳定文件协议 + Runner 原生 resolver + versioned descriptor |
| Registry 下载/解压不安全 | token 泄漏、路径穿越、缓存污染或压缩炸弹 | 隔离只读身份、checksum-keyed cache、archive 安全上限、只读挂载 |
| Agent 上下文臃肿 | `agent-context.md` 或单体 pixel spec 过长 | `agent-context.md` 只做 briefing；pixel spec / layers 按 frame 和 page region 分片，Agent 先读 index 再按需读取 |
| 误把 briefing 当像素规范 | 只读 `agent-context.md` 会缺少 bounds/style/layer 细节 | 明确 `agent-context.md` 是 briefing，像素实现必须读取 `pixel-spec/index.json` |
| pixel spec 缺失、粒度不足或未分片 | package 只能支撑粗到中等精度实现，Agent 容易宽泛搜索挤占上下文 | validate 标记 warning/blocker，并要求 capture/ingest 侧补充 layer/style/asset binding 和 page region 分片 |
| raw get_design_context 不稳定 | React+Tailwind 原始文本是 source evidence，不是稳定 IR | 保存 source，但以 normalized pixel spec 为实现 contract |
| Figma MCP 输出变化 | Figma MCP 格式可能变化 | Capture Bridge 保存 source 原始输出，adapter 层做兼容，并尽量依赖 Plugin/API 直接节点事实 |
| 每次上传重复 components/assets | 新页面重复带上组件总表和切图 frame，导致包臃肿和依赖不清 | 用 `.pragma/design-sources/` shared snapshots 去重，Issue package 只锁定 snapshot id |
| normalized 文件互相复制 | pixel-spec、layers、assets 都保存同一份 bounds/binding，包变大且易不一致 | 定义 canonical ownership，validate 检查重复事实字段 |
| page region 与语义区域分裂 | 同一页面区域出现 regions / semanticRegions 两套索引，Agent 不知道读哪一个 | 只保留 `pageRegions` 一套概念；语义 role/label/confidence 是 page region 的可选字段 |
| Agent 为还原设计侵入业务代码 | 为了显示设计态而添加生产 fallback 数据、强制选中项或默认打开弹层 | `agent-workflow.md` 强制阻断：需要 sample data 或 runtime state 时先问用户，只能走 preview/dev-only 或 Issue 明确要求 |
| CSS 覆盖链导致短期尾部 override | 老项目全局 CSS/AntD override/大屏样式使局部修改不生效 | workflow 要求优先 scoped style 或组件重构；tail override 只能作为用户批准的短期 spike |
| assets 混入 frame render | screenshots 同时进入 assets，开发 Agent 误当素材使用且包变大 | assets 只保留开发所需素材；frame render 只进 screenshots/visual-baseline |
| 小包重复提交 context.zip | <=20MB 已提交完整目录又提交 zip，repo 体积翻倍 | <=20MB 不提交 context.zip，zip 只作临时 artifact 或 >20MB package 文件 |
| floating latest 造成不可复现 | 历史 Issue 读取到新的组件/切图版本 | `dependencies.json` 永远锁定具体 snapshot checksum，validate 禁止 floating latest |
| Windows/编码/资产格式问题 | PowerShell 编码、中文路径、SVG/PNG 扩展名不一致导致采集失败 | 提供 Pragma deterministic runtime：UTF-8、路径规范、MIME sniff、checksum、结构化错误码 |
| 已有 capture input 小坑导致 Agent 排障耗时 | checksum 占位、asset 尺寸误写 placement、selected snapshot path 未 materialize | 在 ingest/pack 前强制 preflight --fix，自动修复确定性问题并用结构化 blocker 中止不可修复输入 |
| Agent 排障搜索范围过大 | 从父目录或磁盘根递归搜索会扫到无关 repo、node_modules 和大型 sourcemap，造成“preflight 很慢”的误判 | 固定 wrapper/CLI 入口，只在目标 repo `.pragma/` 和 Pragma CLI repo 内搜索；日志记录实际 CLI 分阶段耗时 |
| Gitea 包大小限制 | 实例配置或反向代理可能限制上传 | MVP 前确认限制，超大包再评估 Git LFS |
| Issue 变臃肿 | 把设计细节塞进 Issue | Issue 只保留 design 分类、manifest、蓝湖链接、业务运行状态/验收口径和极短备注；像素事实仍在 Pragma package |
| 人类验收责任不清 | 误以为 Pragma 自动验收 | 明确 Pragma 不做验收裁判，Issue 默认人类验收 |
| 设计稿非绝对真理 | 地图/图表/三维无法像素还原，设计截图里的选中/打开/样例数据也不一定是运行默认态 | dynamicRegions 表达非像素区域；业务运行默认态由开发 Issue 描述，Agent 不得用 mock/fallback 数据侵入业务代码 |

---

## 21. 近期功能拆分与归属

以下任务来自 issue-3 试点复盘，按“本体 core/CLI”与“Figma Plugin / Capture Bridge”拆分。优先级用于开发排期，不改变 package contract。

### 21.1 本体 core / CLI

```text
P0 已完成/保持：
- preflight --fix 处理 checksum unavailable、尺寸/MIME、dependency snapshot materialization；
- pack-from-figma-capture 默认执行 preflight -> ingest -> pack -> publish -> issue-fragment -> validate -> read smoke-check；
- validate 作为末端 guard，不修改输入；
- `design read` 作为生产 smoke-check / 人工诊断保留，不作为开发者、app-server 或开发 Agent 的运行时依赖。

P1 新增：
- Pipeline tracing：preflight、ingest、pack zip、publish、issue-fragment、validate、read smoke-check 分阶段 timings；
- `handoff/pipeline-summary.json`：记录 input、context、manifest、issue fragment、artifact、preflight repairs、validation warnings、read smoke-check 和 timings；
- 生成 `normalized/agent-workflow.md`，固化 progressive disclosure、typography、business data safety、CSS strategy 规则；
- 生成 `design-context.json.pageRegions`，并把 page region 与 pixel spec/layer 分片互相引用；
- 将 `pixel-spec` / `layers` 从单体 JSON 升级为 index + frame/region 分片；legacy 聚合文件只作为兼容派生物；
- Validate-based source registry health：在现有 validate 基础上检查 `.pragma/design-sources/figma/<fileKey>/` 的 registry、sources、snapshots、latest 指针、snapshot checksums；
- Context validate 联动 dependency lock：验证 `normalized/dependencies.json` 锁定的 components/assets snapshot path/checksum 可以从 repo 恢复，禁止 floating latest。

P2 当前启动（CLI 集成）：
- 实现跨平台 `pragma design pack-latest-capture`，作为 PowerShell wrapper 试点能力的正式本体 CLI 入口；
- 自动发现只允许在显式 `--repo` 的 `.pragma/incoming/figma-captures/issue-<number>-*/pragma-input/` 内选择最新输入，不得扫描父目录、磁盘根目录、无关项目或 node_modules；
- 支持 `--input` 显式覆盖、`--preflight-only`、`--force`、`--threshold-mb`、`--json`，并输出 input/context/manifest/issue-fragment/artifact/preflight/validate/read smoke-check/timings/summaryPath；
- 已存在 context 时默认拒绝覆盖，显式 `--force` 才可重跑；所有删除/覆盖必须落在 Pragma 管理目录内并先校验 resolved absolute path；
- `scripts/Invoke-PragmaCapturePipeline.ps1` 降级为 Windows 兼容 shim，只调用 Node CLI 并透传结果，不再维护独立 pipeline 逻辑。

```

验收要求：

```text
- npm test 覆盖 timings 字段、pipeline-summary.json、agent-workflow.md 生成、pageRegions 生成、pixel-spec/layers 分片、validate source-registry 模式、broken latest、missing snapshot、checksum mismatch；
- npm test 覆盖 pack-latest-capture 的最新 capture 解析、repo 外不扫描、preflight-only、无 force 拒绝覆盖、force 重跑、显式 input、JSON 输出和 summary 写入；
- validate 只报告错误和 warnings，不自动 repair；repair 仍通过 preflight/source sync；
- CLI JSON 输出不得要求 Agent 解析自然语言日志；
- fixture 覆盖大屏类页面：Agent 可只读取相关 page region 分片，且 typography 信息无需全包 rg 即可获得。
```

### 21.2 Figma Plugin / Capture Bridge

```text
P0 已完成/保持：
- page/components/assets 三类 frame slot；
- 输出 pragma-input/、dependency-lock.json、figma/*.json、assets-manifest.json、asset-bindings.json、screenshots/、assets/；
- bridge error 使用结构化 JSON，plugin UI 展示可读错误。

P1 新增/加固：
- Capture 输出质量：checksum 不可用时只写 `checksumStatus: "unavailable"` 或省略 checksum，不写伪 sha256；
- Capture 输出 Figma 原生 component metadata：mainComponent、componentSet、variant properties、component properties、visibility/hidden、node type/role/size；prototype 和 pluginData 不作为 MVP 必采；
- asset width/height 必须来自真实导出文件像素尺寸，placement 只写 bindings；
- serializer/bridge 显式 UTF-8 写 JSON/Markdown，中文 fileName/nodeName round-trip 不出现 mojibake；
- bridge response 增加可选 capture timings：serialize、export screenshots、export assets、write files、dependency lock；
- selected components/assets 不伪造 future snapshot path；如不能 materialize，只标记 pending-preflight / needsSourceSync，交给 core preflight。

P2 可选：
- 增加 capture diagnostics：frame role summary、asset checksum unavailable count、unresolved shared refs、dynamic region notes missing 提示；
- bridge health/detail 端点返回版本、repo、write root、last capture summary，方便 Plugin UI 展示排障信息。
```

验收要求：

```text
- packages/figma-capture 测试覆盖 checksum unavailable、真实图片尺寸、UTF-8 中文、component metadata、visibility/hidden、bridge structured error、selected pending-preflight；
- build/typecheck/test 通过；
- 输出目录继续符合 15.8 Capture 输出契约。
```

## 22. 待确认问题

当前产品口径已按“公司 MinIO / issue dependency 启用”设计，但仍需要部署方确认操作细节：

1. MinIO bucket policy、read/publish identity 拆分、object lifecycle、单文件限制，以及当前 HTTP endpoint 的 TLS/受控网络方案。
2. Gitea issue dependency 的具体 API、UI 表达和通用 blocked 规范字段。
3. 通用 Issue 写入工具如何消费 Pragma 生成的 markdown，并如何创建 / 更新 dependency。
4. Issue 模板最终文本，包括开发 Issue 和 Design Issue 中设计相关字段的固定格式。
5. 蓝湖链接是否长期稳定可访问，以及是否需要在 Pragma context 中保留蓝湖链接快照。
6. Pragma 2.0 package version 的保留周期和清理策略；Pragma 1.0 旧包不要求保留。
7. Shared components/assets snapshots 的保留周期、手动 pin 策略和清理 UI。
8. Figma Plugin 中 page/components/assets 三类 frame 的默认识别方式、错误提示和多人协作权限边界。
9. 当 page frame 引用多个 components/assets 来源时，是否允许一个 Issue package 锁定多个 snapshot。
10. Runner materializer 的独立运行身份、cache root、保留期、清理策略和解压安全上限由部署方最终确认。

---

## 23. 最终口径

Pragma 2.0 MVP 的核心价值不是重做设计工具，也不是做设计 CI，而是让设计稿在 AI 开发流程中变成可交付、可引用、可版本化、可被 Agent 消费的上下文包。

最终流程：

```text
飞书 PRD 给业务共识
Figma / 设计工具给设计事实
Codex intake 生成开发 Issue，并在需要时生成 Design Issue
开发 Issue 通过 dependency 依赖 Design Issue
设计师端 Figma Plugin / Capture Bridge 让用户选择 page/components/assets 三类 frame
page frame 生成当前 Issue 的页面上下文；components/assets frame 生成或复用 shared snapshots
Pragma 接收采集输出并生成 Agent 可读 Design Context Package
normalized/pixel-spec/index.json 与 frame/region 分片成为像素实现主规范，包含页面 frame 下每个实现节点和组件实例的位置
normalized/dependencies.json 锁定本包使用的 components/assets snapshot，不依赖 floating latest
source/figma-get-design-context.md 仅作为 fallback/source evidence
<=20MB 的 Pragma context 以版本目录写入同一 Gitea repo，不提交 context.zip
>20MB 的完整 context.zip 发布到公司 MinIO，repo 保留入口索引
Design PR 合入默认分支后，Design Issue 由通用 Issue 写入工具回填 Pragma current pointer / manifest / package
Governance Runner 从 pinned 默认分支 commit 原生解析 current.json / manifest；MinIO 包由隔离 materializer 安全物化
Runner 输出 pragma-context-descriptor/v1 后启动 Codex app-server，Agent 按 read order 直接读取只读 context
开发者、app-server 和开发 Agent 不安装或调用 Pragma CLI，也不持有 MinIO credential
PR / 人类验收决定是否进入下一轮 Issue loop
```

# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,photo}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,CompareView}.tsx
        └── utils/{db,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，序号跳号报错 | PrepProcedure、Specimen |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记 | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 四张表：`specimens`（标本）、`procedures`（修复工序 + 设备时段占用 `bookings` + 计划时段 `planStartAt`）、`supplies`（工具材料批次，入库量 `stockQty` + 领用流水 `issues`）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移（占用账并账）：
  - 批次改「入库量 `stockQty` + 领用流水」模型，余量一律按 `入库量 − 有效领用` 重算；老批次入库量按「现存 + 原有效领用」还原。
  - 工序补 `planStartAt` / `bookings`；**旧数据缺领用记录的工序，按耗时每 60 min 回填 1 个单位（至少 1）胶种消耗**，回填记录带 `backfilled` 标记。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、5 个材料批次（含真空浸渗罐设备与时段占用）与 2 张留痕影像，便于直接查看。

## 功能要点

- **同一份占用账**：工序节点、材料批次、标本档案共用同一本 IndexedDB 账；领用与设备占用在同一个 `rw` 事务内完成，写库失败整笔回滚、余量恢复原样。
- **余量按领用记录重算**：余量 = 入库量 − 有效领用流水；多窗口各开各的页面时，以事务内最新流水为准，后保存不会拿旧余量重复扣。领用时余量不足或批次已过保质期，整道工序退回修改、不写任何数据，表单草稿保留可接着改（另存 `localStorage` 草稿可跨刷新恢复）。
- **设备时段先到先得**：工具类批次（真空浸渗罐等）按「设备批次 + 计划时段」登记占用；同一设备同一时段两份占用同时提交时只留 `claimedAt` 先到者，当场显示先到占用方（标本/工序）与责任人；时段边界相接不算冲突。
- **回退 / 改时段即重算**：工序回退作废其领用流水（余量恢复）、释放设备占用；改动计划时段后设备占用立即重算，冲突则原账不动；材料台账的设备占用看板与「前后对照说明」随之失效重算。
- **多窗口同步**：通过 BroadcastChannel（降级 localStorage storage 事件）广播占用账变更，其它窗口即时重拉工序与材料两本账。
- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **旧数据回填**：缺领用记录的老工序按耗时回填胶种消耗（见 v3 迁移）。
- **低量 / 过期高亮**：在库余量 ≤ 低量阈值整行高亮「低量」，超过保质期红色标注且禁止领用。
- **批号追溯**：按批号片段检索，行内展示该批次全部领用明细（含随回退作废的记录与回填标记）。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本（含设备时段占用与材料领用占用）。

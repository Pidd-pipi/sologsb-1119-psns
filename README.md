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
npm run dev          # http://localhost:5173
npm run build        # tsc 类型检查 + vite 构建
npm run verify:ledger # 用 fake-indexeddb 验证占用账事务（余量重算/冲突/回退/回填）
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
        ├── types/{specimen,procedure,supply,occupation,photo}.ts
        ├── stores/{specimen,procedure,supply,occupation}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,OccupancyBoard,CompareView}.tsx
        ├── scripts/{fake-idb,verify-ledger}.ts    # 占用账事务行为验证（fake-indexeddb）
        └── utils/{db,ledger,backfill,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕，节点可回退/改期 | Specimen、PrepProcedure、PrepPhoto、EquipmentOccupation |
| `/procedures/new` | 新建工序节点：选胶种批次、填设备占用时段，余量/保质期/设备冲突当场校验 | PrepProcedure、SupplyLot、EquipmentOccupation |
| `/supplies` | 工具材料台账：余量实时重算、批号追溯、低量/过期高亮、领用登记 | SupplyLot |
| `/occupations` | 设备占用台账：同一设备同一时段的占用方/责任人一览，支持改期重争用 | EquipmentOccupation |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明（含设备占用与有效领用，回退/改期即重算） | PrepPhoto、PrepProcedure、EquipmentOccupation、SupplyLot |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 五张表：`specimens`（标本）、`procedures`（修复工序）、`supplies`（工具材料批次 + 领用记录）、`photos`（影像 dataUrl 独立表）、`occupations`（**统一占用账 · 设备时段侧**）。
- **同一份占用账**：工序节点、材料批次、标本档案都以领用记录与设备占用记录为准，所有写操作在同一个 Dexie 事务内完成。
  - 材料余量永远按「初始量 − 有效领用记录」实时重算（`remainingQty`），不再把余量写回批次字段，杜绝多窗口后保存重复扣减。
  - 同一设备（如真空浸渗罐）同一时段只留一条 `active` 占用，按提交时间 `claimedAt` 先到先得；后提交的工序被退回并当场显示先到占用方（标本号/工序/责任人/时段）。
  - 余量不足或批次过保质期，整道工序在事务内退回，不落任何数据；写库失败时事务整体回滚、余量恢复原样，表单草稿存于 `localStorage` 可继续改。
  - 工序回退：其设备占用与领用记录立即 `voided`，余量与对照说明随即失效重算，释放出的时段可被其它工序占用。
  - 时段改动（改期）：旧占用记 `voided` + `replacedBy`，按新时段重新先到先得；争不到则改期不生效、原时段保留。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：新增 `occupations` 表、工序加 `planStart`；**旧数据缺领用记录的工序按耗时回填一条胶种消耗**（每满 30 分钟计 1 个单位，至少 1，标记 `backfilled`），并为使用独占设备的旧工序补一条时段占用；已回退工序的回填记录直接作废。回填逻辑幂等，启动时对老库再兜底执行一次。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点（其中 1 道占用真空浸渗罐）、4 个材料批次（含 1 个已过期胶种，用于演示退回）与 2 张留痕影像。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **材料领用按记录重算**：选胶种批次时下拉直接显示该批实时余量与剩余保质期；不足或过期当场标红，提交时事务内复核。
- **设备时段先到先得**：表单内实时预演当前时段占用方；两份占用同时提交只留先到者，并显示占用方与责任人。
- **工序回退/改期**：回退作废占用与领用并恢复余量；改期作废旧占用、新时段重新争用。占用台账与对照说明实时反映。
- **写库失败保护**：勾选「演练：制造一次扣减写库失败」可观察事务回滚（余量不扣、占用不登记）且草稿保留。
- **工序回退计数**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。

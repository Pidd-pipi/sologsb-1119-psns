import Dexie, { type Table } from 'dexie';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot, SupplyIssue } from '../types/supply';
import type { PrepPhoto } from '../types/photo';
import { makeSketchDataUrl } from '../types/photo';
import { newId } from './id';

/** 当前数据结构版本，写入 localStorage 便于回显 */
export const DB_VERSION = 3;
export const DB_NAME = 'gbfossilprep';
export const LS_VERSION_KEY = 'gbfossilprep:db-version';

class FossilPrepDB extends Dexie {
  specimens!: Table<Specimen, string>;
  procedures!: Table<PrepProcedure, string>;
  supplies!: Table<SupplyLot, string>;
  photos!: Table<PrepPhoto, string>;

  constructor() {
    super(DB_NAME);
    // v1：初版四张业务表
    this.version(1).stores({
      specimens: 'id, specimenNo, taxon, locality, status, createdAt',
      procedures: 'id, specimenId, seq, stepType, state',
      supplies: 'id, kind, lotNo, name',
      photos: 'id, specimenId, procedureId, stage',
    });
    // v2：工序增加 state 索引与 finishedAt；影像增加 stage 索引
    this.version(2)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        // 老版本记录缺字段，迁移时逐表补齐（用宽松类型，避免升级事务里做多余断言）
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (!row.state) row.state = 'pending';
            if (row.tools === undefined) row.tools = [];
            if (row.photoBeforeIds === undefined) row.photoBeforeIds = [];
            if (row.photoAfterIds === undefined) row.photoAfterIds = [];
            if (row.adhesiveConc === undefined) row.adhesiveConc = 0;
          });
        await tx
          .table('supplies')
          .toCollection()
          .modify((row: any) => {
            if (!row.issues) row.issues = [];
            if (row.lowThreshold === undefined) row.lowThreshold = 1;
          });
      });
    // v3：材料批次改「入库量 + 领用流水」占用账；工序增加计划时段与设备占用；老数据按耗时回填消耗
    this.version(3)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt, planStartAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        const procTable = tx.table<PrepProcedure, string>('procedures');
        const supplyTable = tx.table<SupplyLot, string>('supplies');
        const procs = await procTable.toCollection().toArray();
        const lots = await supplyTable.toCollection().toArray();
        const specimenRows = await tx.table<Specimen, string>('specimens').toArray();
        const specimenNoOf = (sid: string) => specimenRows.find((s) => s.id === sid)?.specimenNo ?? '';

        // 1) 先为缺领用记录的老工序按耗时算出回填消耗（每满 60 min 计 1 单位，至少 1），按批次归集
        const backfillsByLot = new Map<string, SupplyIssue[]>();
        const procPatch = new Map<string, Partial<PrepProcedure>>();
        for (const proc of procs) {
          const patch: Partial<PrepProcedure> = {
            planStartAt: proc.planStartAt ?? proc.startedAt,
            bookings: proc.bookings ?? [],
          };
          if (proc.adhesive) {
            const lot = lots.find((l) => l.name === proc.adhesive && l.kind === '胶种');
            const linked = lot?.issues.some((it) => it.procedureId === proc.id && it.status === 'active');
            if (lot && !linked) {
              const qty = Math.max(1, Math.round((proc.durationMin || 60) / 60));
              const issue: SupplyIssue = {
                id: newId('iss'),
                qty,
                operator: proc.operator,
                specimenNo: specimenNoOf(proc.specimenId),
                specimenId: proc.specimenId,
                procedureId: proc.id,
                issuedAt: proc.startedAt,
                status: 'active',
                backfilled: true,
              };
              backfillsByLot.set(lot.id, [...(backfillsByLot.get(lot.id) ?? []), issue]);
              patch.adhesiveLotId = lot.id;
              patch.adhesiveQty = qty;
            }
          }
          procPatch.set(proc.id, patch);
        }

        // 2) 批次统一立账：老账上的 qty 是「扣过历史领用后的现存」，
        //    入库量 = 现存 + 原有效领用，再兜底覆盖回填消耗；余量按流水重算且不为负
        for (const lot of lots) {
          const oldIssues: SupplyIssue[] = (lot.issues ?? []).map((it) => ({
            ...it,
            status: it.status ?? 'active',
          }));
          const backfills = backfillsByLot.get(lot.id) ?? [];
          const allIssues = [...backfills, ...oldIssues];
          const oldIssuedSum = oldIssues
            .filter((it) => it.status === 'active')
            .reduce((s, it) => s + it.qty, 0);
          const issuedSum = allIssues
            .filter((it) => it.status === 'active')
            .reduce((s, it) => s + it.qty, 0);
          const onHand = lot.qty ?? 0;
          // 已有新版 stockQty 时直接沿用；老数据按「现存 + 原有效领用」还原入库量，
          // 若回填后总消耗更高（现存可能本就不足），再抬高到总消耗以免余量为负。
          const stockQty = lot.stockQty ?? Math.max(onHand + oldIssuedSum, issuedSum);
          await supplyTable.update(lot.id, {
            stockQty,
            qty: Math.max(0, stockQty - issuedSum),
            issues: allIssues,
          });
        }

        // 3) 工序补齐计划时段、设备占用、领用回指
        for (const [id, patch] of procPatch) {
          await procTable.update(id, patch);
        }
      });
  }
}

export const db = new FossilPrepDB();

/** 记录结构版本，迁移完成后回写 */
export async function markDbVersion(): Promise<void> {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入时灌入示范档案，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.specimens.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const specimenId = newId('spm');
  const specimenId2 = newId('spm');

  const specimens: Specimen[] = [
    {
      id: specimenId,
      specimenNo: 'FP-2024-0031',
      taxon: 'Sinokannemeyeria yingchiaoensis（山西肯氏兽）',
      horizon: '中三叠统二马营组',
      locality: '山西武乡',
      lithology: '紫红色粉砂质泥岩',
      matrixHardness: 2.5,
      dimensions: '320×210×150',
      weight: 4820,
      storageBox: 'A 区 3 匣 2 格',
      status: '修复中',
      createdAt: now - 12 * day,
    },
    {
      id: specimenId2,
      specimenNo: 'FP-2024-0058',
      taxon: 'Psittacosaurus sp.（鹦鹉嘴龙）',
      horizon: '下白垩统义县组',
      locality: '辽宁北票',
      lithology: '灰绿色凝灰质砂岩',
      matrixHardness: 4.2,
      dimensions: '180×120×90',
      weight: 1640,
      storageBox: 'B 区 1 匣 4 格',
      status: '待清修',
      createdAt: now - 5 * day,
    },
  ];

  const vacuumLotId = newId('sup');
  const adhesiveIssueId = newId('iss');
  const proc2Id = newId('prc');

  const procedures: PrepProcedure[] = [
    {
      id: newId('prc'),
      specimenId,
      stepType: '清修',
      nodeName: '左侧肩胛区粗清',
      seq: 1,
      tools: ['气动笔', '剔针'],
      abrasive: '800 目',
      adhesive: '',
      adhesiveConc: 0,
      durationMin: 145,
      tempC: 22,
      rh: 48,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 10 * day,
      planStartAt: now - 10 * day,
      state: 'done',
      finishedAt: now - 10 * day + 145 * 60000,
      bookings: [],
    },
    {
      id: proc2Id,
      specimenId,
      stepType: '加固',
      nodeName: '围岩裂隙渗透加固',
      seq: 2,
      tools: ['渗透滴管', '真空浸渗罐'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 5,
      adhesiveLotId: undefined, // 下方 supplies 中用批号回填
      durationMin: 90,
      tempC: 23,
      rh: 45,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 6 * day,
      planStartAt: now - 6 * day,
      state: 'pending',
      bookings: [
        {
          lotId: vacuumLotId,
          lotName: '真空浸渗罐',
          lotNo: 'VAC-100L-02',
          startAt: now - 6 * day,
          endAt: now - 6 * day + 90 * 60000,
          claimedAt: now - 6 * day,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
        },
      ],
    },
  ];

  const photos: PrepPhoto[] = [
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'before',
      caption: '清修前 · 左侧肩胛区围岩包裹',
      dataUrl: makeSketchDataUrl('清修前 · FP-2024-0031', '#6b5844'),
      capturedAt: now - 10 * day,
    },
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'after',
      caption: '清修后 · 肩胛骨轮廓显露',
      dataUrl: makeSketchDataUrl('清修后 · FP-2024-0031', '#3f5a4a'),
      capturedAt: now - 9 * day,
    },
  ];
  procedures[0].photoBeforeIds = [photos[0].id];
  procedures[0].photoAfterIds = [photos[1].id];

  const b72LotId = newId('sup');
  procedures[1].adhesiveLotId = b72LotId;
  procedures[1].adhesiveQty = 1;

  const supplies: SupplyLot[] = [
    {
      id: b72LotId,
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g',
      lotNo: 'B72-20240312',
      stockQty: 5,
      qty: 4,
      unit: '瓶',
      openedAt: now - 40 * day,
      shelfLifeMonths: 36,
      lowThreshold: 2,
      issues: [
        {
          id: adhesiveIssueId,
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          specimenId,
          procedureId: proc2Id,
          issuedAt: now - 6 * day,
          status: 'active',
        },
      ],
    },
    {
      id: newId('sup'),
      name: '碳化硅磨料',
      kind: '磨料',
      spec: '800 目 1 kg',
      lotNo: 'SIC-800-2401',
      stockQty: 1,
      qty: 1,
      unit: '袋',
      openedAt: now - 60 * day,
      shelfLifeMonths: 60,
      lowThreshold: 2,
      issues: [],
    },
    {
      id: newId('sup'),
      name: '气动笔针头',
      kind: '耗材',
      spec: '钨钢 2.3 mm',
      lotNo: 'NEEDLE-2312',
      stockQty: 18,
      qty: 18,
      unit: '支',
      openedAt: now - 90 * day,
      shelfLifeMonths: 120,
      lowThreshold: 5,
      issues: [],
    },
    {
      id: newId('sup'),
      name: '超声波清洗机',
      kind: '工具',
      spec: '6 L / 40 kHz',
      lotNo: 'US-6L-01',
      stockQty: 1,
      qty: 1,
      unit: '台',
      openedAt: now - 200 * day,
      shelfLifeMonths: 120,
      lowThreshold: 1,
      issues: [],
    },
    {
      id: vacuumLotId,
      name: '真空浸渗罐',
      kind: '工具',
      spec: '100 L / 耐负压',
      lotNo: 'VAC-100L-02',
      stockQty: 1,
      qty: 1,
      unit: '台',
      openedAt: now - 180 * day,
      shelfLifeMonths: 120,
      lowThreshold: 1,
      issues: [],
    },
  ];

  await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, async () => {
    await db.specimens.bulkPut(specimens);
    await db.procedures.bulkPut(procedures);
    await db.supplies.bulkPut(supplies);
    await db.photos.bulkPut(photos);
  });
}

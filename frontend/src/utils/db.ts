import Dexie, { type Table } from 'dexie';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import type { PrepPhoto } from '../types/photo';
import type { EquipmentOccupation } from '../types/occupation';
import { makeSketchDataUrl } from '../types/photo';
import { newId } from './id';
import { backfillLegacyOccupancy } from './backfill';

/** 当前数据结构版本，写入 localStorage 便于回显 */
export const DB_VERSION = 3;
export const DB_NAME = 'gbfossilprep';
export const LS_VERSION_KEY = 'gbfossilprep:db-version';

class FossilPrepDB extends Dexie {
  specimens!: Table<Specimen, string>;
  procedures!: Table<PrepProcedure, string>;
  supplies!: Table<SupplyLot, string>;
  photos!: Table<PrepPhoto, string>;
  /** 统一占用账（设备时段侧） */
  occupations!: Table<EquipmentOccupation, string>;

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
    // v3：统一占用账 —— 新增 occupations 表；工序加 planStart；旧工序按耗时回填领用与占用
    this.version(3)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt, planStart',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
        occupations: 'id, equipment, status, startAt, endAt, claimedAt, procedureId, specimenId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (row.planStart === undefined) row.planStart = row.startedAt ?? Date.now();
            if (row.tools === undefined) row.tools = [];
          });
        await tx
          .table('supplies')
          .toCollection()
          .modify((row: any) => {
            if (!row.issues) row.issues = [];
          });
        // 旧数据缺领用记录的工序，按耗时回填一条消耗；缺设备占用的补一条时段占用
        await backfillLegacyOccupancy({
          procedures: tx.table('procedures'),
          supplies: tx.table('supplies'),
          specimens: tx.table('specimens'),
          occupations: tx.table('occupations'),
        });
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

/** 首次进入时灌入一条示范档案，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.specimens.count();
  if (count > 0) {
    // 老库（v3 之前已有数据）也兜一次底，保证缺记录的旧工序都补齐占用账（幂等）
    await backfillLegacyOccupancy({
      procedures: db.procedures,
      supplies: db.supplies,
      specimens: db.specimens,
      occupations: db.occupations,
    });
    return;
  }

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

  // 真空浸渗罐时段：第一道加固占用明天 09:00–10:30
  const tankStart = dayStart(now + 1 * day) + 9 * 3600 * 1000;
  const proc1Start = now - 10 * day;
  const proc2Start = tankStart;
  const proc2Duration = 90;
  const proc2Id = newId('prc');
  const occ2Id = newId('occ');

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
      planStart: proc1Start,
      tempC: 22,
      rh: 48,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: proc1Start,
      state: 'done',
      finishedAt: proc1Start + 145 * 60000,
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
      adhesiveLotId: 'seed-lot-b72',
      adhesiveIssueQty: 1,
      occupationId: occ2Id,
      durationMin: proc2Duration,
      planStart: proc2Start,
      tempC: 23,
      rh: 45,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 6 * day,
      state: 'pending',
    },
  ];

  const occupations: EquipmentOccupation[] = [
    {
      id: occ2Id,
      equipment: '真空浸渗罐',
      startAt: proc2Start,
      endAt: proc2Start + proc2Duration * 60000,
      claimedAt: now - 6 * day,
      procedureId: proc2Id,
      nodeName: '围岩裂隙渗透加固',
      stepType: '加固',
      operator: '林砚秋',
      specimenId,
      specimenNo: 'FP-2024-0031',
      seq: 2,
      status: 'active',
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

  const supplies: SupplyLot[] = [
    {
      id: 'seed-lot-b72',
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g',
      lotNo: 'B72-20240312',
      qty: 4,
      unit: '瓶',
      openedAt: now - 40 * day,
      shelfLifeMonths: 36,
      lowThreshold: 2,
      issues: [
        {
          id: newId('iss'),
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          specimenId,
          procedureId: proc2Id,
          source: 'procedure',
          lotName: 'Paraloid B-72',
          lotNo: 'B72-20240312',
          issuedAt: now - 6 * day,
        },
      ],
    },
    {
      id: newId('sup'),
      name: '氰基丙烯酸酯',
      kind: '胶种',
      spec: '快固 20 g',
      lotNo: 'CA-20230110',
      qty: 6,
      unit: '支',
      openedAt: now - 400 * day,
      shelfLifeMonths: 12,
      lowThreshold: 2,
      issues: [],
    },
    {
      id: newId('sup'),
      name: '碳化硅磨料',
      kind: '磨料',
      spec: '800 目 1 kg',
      lotNo: 'SIC-800-2401',
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
      qty: 18,
      unit: '支',
      openedAt: now - 90 * day,
      shelfLifeMonths: 120,
      lowThreshold: 5,
      issues: [],
    },
  ];

  await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, db.occupations, async () => {
    await db.specimens.bulkPut(specimens);
    await db.procedures.bulkPut(procedures);
    await db.supplies.bulkPut(supplies);
    await db.photos.bulkPut(photos);
    await db.occupations.bulkPut(occupations);
  });
}

/** 当天 00:00 */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

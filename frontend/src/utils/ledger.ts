import { db } from './db';
import { newId } from './id';
import {
  isExpired,
  lotBalance,
  type SupplyIssue,
  type SupplyLot,
} from '../types/supply';
import {
  rangesOverlap,
  type EquipmentBooking,
  type PrepProcedure,
  type PrepProcedureDraft,
} from '../types/procedure';

/** 占用账提交失败原因 */
export type LedgerErrorCode =
  | 'lot_not_found'
  | 'insufficient'
  | 'expired'
  | 'equipment_conflict'
  | 'seq_conflict'
  | 'seq_gap';

export class LedgerError extends Error {
  code: LedgerErrorCode;
  /** 设备冲突时，当场展示先到的占用方与责任人 */
  conflict?: EquipmentConflictInfo;
  details?: string;

  constructor(code: LedgerErrorCode, message: string, conflict?: EquipmentConflictInfo, details?: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.conflict = conflict;
    this.details = details;
  }
}

export interface EquipmentConflictInfo {
  lotId: string;
  lotName: string;
  lotNo: string;
  holderProcedureId: string;
  holderNodeName: string;
  holderSpecimenNo: string;
  holderOperator: string;
  startAt: number;
  endAt: number;
  claimedAt: number;
}

export interface MaterialClaim {
  lotId: string;
  qty: number;
  /** 胶种 / 磨料 */
  role: 'adhesive' | 'abrasive';
}

export interface CreateLedgerInput {
  draft: PrepProcedureDraft;
  /** 本工序领用的材料批次（胶种 / 磨料） */
  claims: MaterialClaim[];
  specimenNo: string;
  /** 设备占用时段起点；未传时用 startedAt */
  planStartAt: number;
}

export interface CreateLedgerResult {
  procedure: PrepProcedure;
  /** 提交成功时的占用快照（供页面当场回显） */
  bookings: EquipmentBooking[];
}

/** 取出一条未回退工序持有的全部设备占用 */
export function activeBookingsOf(proc: PrepProcedure): EquipmentBooking[] {
  if (proc.state === 'rolledback') return [];
  return proc.bookings ?? [];
}

/** 在已读入的工序集合中查找同一设备的时段冲突，先到者胜 */
function findConflict(
  bookings: EquipmentBooking[],
  others: PrepProcedure[],
  selfId?: string,
): EquipmentConflictInfo | undefined {
  for (const booking of bookings) {
    for (const other of others) {
      if (other.id === selfId || other.state === 'rolledback') continue;
      const held = (other.bookings ?? []).find((b) => b.lotId === booking.lotId);
      if (!held) continue;
      if (rangesOverlap(booking.startAt, booking.endAt, held.startAt, held.endAt)) {
        return {
          lotId: held.lotId,
          lotName: held.lotName,
          lotNo: held.lotNo,
          holderProcedureId: other.id,
          holderNodeName: other.nodeName,
          holderSpecimenNo: held.specimenNo,
          holderOperator: held.operator,
          startAt: held.startAt,
          endAt: held.endAt,
          claimedAt: held.claimedAt,
        };
      }
    }
  }
  return undefined;
}

/**
 * 新建工序节点：工序、材料批次、标本共用同一份占用账。
 * 单事务内：
 *  1. 校序号（不重复、不跳号）；
 *  2. 按这批已有的领用记录重算余量，不够或过期直接整笔退回（不写任何数据，草稿保留）；
 *  3. 设备同一时段两份占用同时提交，只留先到者（claimedAt 小者），当场返回占用方与责任人；
 *  4. 任一步失败事务回滚，库存余量恢复原样。
 */
export async function createProcedureWithOccupancy(
  input: CreateLedgerInput,
): Promise<CreateLedgerResult> {
  const { draft, claims, specimenNo, planStartAt } = input;
  const id = newId('prc');
  const claimedAt = Date.now();

  return db.transaction('rw', db.procedures, db.supplies, async () => {
    // —— 事务内重读最新账本，杜绝内存旧快照 ——
    const allProcs = await db.procedures.where('specimenId').equals(draft.specimenId).toArray();
    const seqs = allProcs.map((p) => p.seq);
    if (seqs.includes(draft.seq)) {
      throw new LedgerError('seq_conflict', `序号 ${draft.seq} 已被占用`);
    }
    if (allProcs.length > 0 && draft.seq > Math.max(...seqs) + 1) {
      throw new LedgerError('seq_gap', `序号跳号，下一号应为 ${Math.max(...seqs) + 1}`);
    }

    // —— 材料领用：以事务内最新 issues 重算余量 ——
    const lotCache = new Map<string, SupplyLot>();
    for (const claim of claims) {
      if (!(claim.qty > 0)) continue;
      const lot = await db.supplies.get(claim.lotId);
      if (!lot) {
        throw new LedgerError('lot_not_found', `材料批次已不存在，请重新选择`);
      }
      lotCache.set(lot.id, lot);
      if (isExpired(lot)) {
        throw new LedgerError(
          'expired',
          `批号 ${lot.lotNo}（${lot.name}）已过保质期，请退回改选其它批次`,
          undefined,
          lot.lotNo,
        );
      }
      const balance = lotBalance(lot);
      if (claim.qty > balance) {
        throw new LedgerError(
          'insufficient',
          `批号 ${lot.lotNo}（${lot.name}）余量仅 ${balance} ${lot.unit}，本次需 ${claim.qty} ${lot.unit}，请退回改小用量或换批`,
          undefined,
          lot.lotNo,
        );
      }
    }

    // —— 设备占用：按选中的工具类批次建账 ——
    const equipmentLots = (await db.supplies.where('kind').equals('工具').toArray()).filter(
      (lot) => draft.tools.includes(lot.name),
    );
    const startAt = planStartAt;
    const endAt = startAt + Math.max(1, draft.durationMin) * 60000;
    const bookings: EquipmentBooking[] = equipmentLots.map((lot) => ({
      lotId: lot.id,
      lotName: lot.name,
      lotNo: lot.lotNo,
      startAt,
      endAt,
      claimedAt,
      operator: draft.operator,
      specimenNo,
    }));

    const allOtherProcs = await db.procedures.toArray();
    const conflict = findConflict(bookings, allOtherProcs);
    if (conflict) {
      throw new LedgerError(
        'equipment_conflict',
        `设备「${conflict.lotName}」（批号 ${conflict.lotNo}）在该时段已被先占用`,
        conflict,
      );
    }

    // —— 全部校验通过后才落账：领用流水 + 工序 ——
    const record: PrepProcedure = {
      ...draft,
      id,
      planStartAt: startAt,
      bookings,
      adhesiveLotId: claims.find((c) => c.role === 'adhesive')?.lotId ?? draft.adhesiveLotId,
      abrasiveLotId: claims.find((c) => c.role === 'abrasive')?.lotId ?? draft.abrasiveLotId,
      adhesiveQty: claims.find((c) => c.role === 'adhesive')?.qty ?? draft.adhesiveQty,
      abrasiveQty: claims.find((c) => c.role === 'abrasive')?.qty ?? draft.abrasiveQty,
      bookingConflict: undefined,
    };

    for (const claim of claims) {
      if (!(claim.qty > 0)) continue;
      const lot = lotCache.get(claim.lotId);
      if (!lot) continue;
      const issue: SupplyIssue = {
        id: newId('iss'),
        qty: claim.qty,
        operator: draft.operator,
        specimenNo,
        specimenId: draft.specimenId,
        procedureId: id,
        issuedAt: claimedAt,
        status: 'active',
      };
      const issues = [issue, ...lot.issues];
      const stockQty = lot.stockQty ?? lot.qty;
      const next: SupplyLot = {
        ...lot,
        issues,
        qty: Math.max(0, stockQty - issues.filter((it) => it.status === 'active').reduce((s, it) => s + it.qty, 0)),
      };
      await db.supplies.put(next);
    }

    await db.procedures.put(record);
    return { procedure: record, bookings };
  });
}

/**
 * 工序回退：作废它产生的领用流水（余量立即恢复），释放设备时段占用。
 * 同一事务完成；失败整笔回滚。
 */
export async function rollbackProcedure(id: string, reason = '工序回退'): Promise<PrepProcedure> {
  return db.transaction('rw', db.procedures, db.supplies, async () => {
    const proc = await db.procedures.get(id);
    if (!proc) throw new LedgerError('lot_not_found', '工序不存在');

    const now = Date.now();
    // 1) 作废该工序的有效领用记录，余量按流水自然恢复
    if (proc.adhesiveLotId || proc.abrasiveLotId) {
      const lotIds = [proc.adhesiveLotId, proc.abrasiveLotId].filter(Boolean) as string[];
      for (const lotId of lotIds) {
        const lot = await db.supplies.get(lotId);
        if (!lot) continue;
        const issues = lot.issues.map((it) =>
          it.procedureId === id && it.status === 'active'
            ? { ...it, status: 'voided' as const, voidReason: reason, voidedAt: now }
            : it,
        );
        const stockQty = lot.stockQty ?? lot.qty;
        const next: SupplyLot = {
          ...lot,
          issues,
          qty: Math.max(0, stockQty - issues.filter((it) => it.status === 'active').reduce((s, it) => s + it.qty, 0)),
        };
        await db.supplies.put(next);
      }
    }

    // 2) 释放设备占用、清空对照说明缓存标记
    const next: PrepProcedure = {
      ...proc,
      state: 'rolledback',
      finishedAt: undefined,
      bookings: [],
      bookingConflict: undefined,
    };
    await db.procedures.put(next);
    return next;
  });
}

export interface RescheduleInput {
  id: string;
  planStartAt: number;
}

/**
 * 时段改动：设备占用立即失效重算——重新按新时段抢占；冲突则保持原账不动并退回。
 */
export async function rescheduleProcedure(input: RescheduleInput): Promise<PrepProcedure> {
  const { id, planStartAt } = input;
  return db.transaction('rw', db.procedures, async () => {
    const proc = await db.procedures.get(id);
    if (!proc) throw new LedgerError('lot_not_found', '工序不存在');
    if (proc.state === 'rolledback') {
      throw new LedgerError('equipment_conflict', '已回退节点不能改时段，请先重建节点');
    }
    const endAt = planStartAt + Math.max(1, proc.durationMin) * 60000;
    const rebooked: EquipmentBooking[] = (proc.bookings ?? []).map((b) => ({
      ...b,
      startAt: planStartAt,
      endAt,
      claimedAt: Date.now(),
    }));

    const others = await db.procedures.toArray();
    const conflict = findConflict(rebooked, others, id);
    if (conflict) {
      throw new LedgerError(
        'equipment_conflict',
        `改时段失败：设备「${conflict.lotName}」新时段已被先占用`,
        conflict,
      );
    }

    const next: PrepProcedure = {
      ...proc,
      planStartAt,
      bookings: rebooked,
      bookingConflict: undefined,
    };
    await db.procedures.put(next);
    return next;
  });
}

/** 手工领用（材料台账页）：同样按最新流水重算余量并校验保质期，失败不改账 */
export async function manualIssue(
  lotId: string,
  payload: { qty: number; operator: string; specimenNo: string; specimenId?: string },
): Promise<void> {
  await db.transaction('rw', db.supplies, async () => {
    const lot = await db.supplies.get(lotId);
    if (!lot) throw new LedgerError('lot_not_found', '批次不存在');
    if (isExpired(lot)) {
      throw new LedgerError('expired', `批号 ${lot.lotNo} 已过保质期，禁止领用`);
    }
    const balance = lotBalance(lot);
    if (!(payload.qty > 0) || payload.qty > balance) {
      throw new LedgerError(
        'insufficient',
        `余量仅 ${balance} ${lot.unit}，领用数量需在 1 ~ ${balance} 之间`,
      );
    }
    const issue: SupplyIssue = {
      id: newId('iss'),
      qty: payload.qty,
      operator: payload.operator,
      specimenNo: payload.specimenNo,
      specimenId: payload.specimenId,
      issuedAt: Date.now(),
      status: 'active',
    };
    const issues = [issue, ...lot.issues];
    const stockQty = lot.stockQty ?? lot.qty;
    const next: SupplyLot = {
      ...lot,
      issues,
      qty: Math.max(0, stockQty - issues.filter((it) => it.status === 'active').reduce((s, it) => s + it.qty, 0)),
    };
    await db.supplies.put(next);
  });
}

/** 时间戳格式化为 yyyy-MM-ddTHH:mm，供 datetime-local 控件使用 */
export function toDatetimeLocalValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

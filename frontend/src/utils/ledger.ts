import { db } from './db';
import { newId } from './id';
import { isExpired, remainingQty, type SupplyIssue } from '../types/supply';
import type { PrepProcedure, PrepProcedureDraft } from '../types/procedure';
import { isSharedEquipment } from '../types/procedure';
import {
  findAllConflicts,
  type EquipmentOccupation,
} from '../types/occupation';

/** 占用账业务拒绝原因 */
export type LedgerRejectCode =
  | 'NO_SPECIMEN'
  | 'SEQ_DUP'
  | 'SEQ_GAP'
  | 'NO_LOT'
  | 'INSUFFICIENT'
  | 'EXPIRED'
  | 'EQUIPMENT_CONFLICT';

/** 占用账拒绝：携带结构化信息，UI 可当场显示占用方/责任人 */
export class LedgerReject extends Error {
  code: LedgerRejectCode;
  conflict?: EquipmentOccupation;
  conflicts?: EquipmentOccupation[];
  remaining?: number;
  unit?: string;

  constructor(
    code: LedgerRejectCode,
    message: string,
    extra?: {
      conflict?: EquipmentOccupation;
      conflicts?: EquipmentOccupation[];
      remaining?: number;
      unit?: string;
    },
  ) {
    super(message);
    this.code = code;
    this.conflict = extra?.conflict;
    this.conflicts = extra?.conflicts;
    this.remaining = extra?.remaining;
    this.unit = extra?.unit;
  }
}

export interface SubmitProcedureInput {
  draft: PrepProcedureDraft;
  /** 为 true 时在落库前制造一次写库失败，用于演示回滚与草稿保留 */
  simulateWriteFailure?: boolean;
}

export interface ManualIssueInput {
  lotId: string;
  qty: number;
  operator: string;
  specimenNo: string;
  specimenId?: string;
}

/**
 * 工序节点、材料批次、标本档案共用的同一份占用账：
 * 全部写操作在同一个 Dexie 事务内完成，读余量/查冲突/扣减/落库一气呵成。
 * 任一环节抛错，Dexie 自动回滚，余量恢复原样，草稿留在界面上继续改。
 */
export const ledger = {
  /**
   * 提交工序节点。
   * - 胶种：按该批次已有领用记录重算余量，不足或过期直接退回（不落任何数据）。
   * - 设备：同一设备同一时段只留先到者，后来者带占用方/责任人信息被退回。
   */
  async submitProcedure({ draft, simulateWriteFailure }: SubmitProcedureInput): Promise<PrepProcedure> {
    return db.transaction(
      'rw',
      db.procedures,
      db.supplies,
      db.occupations,
      db.specimens,
      async () => {
        const specimen = await db.specimens.get(draft.specimenId);
        if (!specimen) {
          throw new LedgerReject('NO_SPECIMEN', '标本不存在或已被删除，请重新选择');
        }

        // 序号：不得占用、不得跳号（在事务内读最新节点，多窗口也成立）
        const sameSpecimen = await db.procedures.where('specimenId').equals(draft.specimenId).toArray();
        const usedSeqs = sameSpecimen.map((p) => p.seq);
        const nextSeq = usedSeqs.length === 0 ? 1 : Math.max(...usedSeqs) + 1;
        if (usedSeqs.includes(draft.seq)) {
          throw new LedgerReject('SEQ_DUP', `序号 ${draft.seq} 已被占用，请改用 ${nextSeq}`);
        }
        if (draft.seq > nextSeq) {
          throw new LedgerReject('SEQ_GAP', `序号跳号：当前最大序号为 ${nextSeq - 1}，新节点必须用 ${nextSeq}`);
        }

        const now = Date.now();
        const procedureId = newId('prc');
        let lotId = '';
        let issueId = '';
        let occupationId = '';

        // —— 材料侧：领用前按这批已有领用记录重算余量 ——
        if (draft.adhesiveLotId) {
          const lot = await db.supplies.get(draft.adhesiveLotId);
          if (!lot) {
            throw new LedgerReject('NO_LOT', '所选胶种批次已不存在，请重新选择');
          }
          const need = draft.adhesiveIssueQty ?? 0;
          if (!(need > 0)) {
            throw new LedgerReject('NO_LOT', '领用数量需大于 0');
          }
          const remaining = remainingQty(lot);
          if (remaining < need) {
            throw new LedgerReject(
              'INSUFFICIENT',
              `批号 ${lot.lotNo}（${lot.name}）余量仅 ${remaining} ${lot.unit}，本次需 ${need} ${lot.unit}，请改用其它批次或减少用量`,
              { remaining, unit: lot.unit },
            );
          }
          if (isExpired(lot, now)) {
            throw new LedgerReject(
              'EXPIRED',
              `批号 ${lot.lotNo}（${lot.name}）已过保质期，不能领用，请退回本道工序改选批次`,
            );
          }
          lotId = lot.id;
          issueId = newId('iss');
        }

        // —— 设备侧：同一设备同一时段先到先得 ——
        const sharedTools = draft.tools.filter(isSharedEquipment);
        const startAt = draft.planStart;
        const endAt = startAt + draft.durationMin * 60000;
        const allOccupations = await db.occupations.toArray();
        for (const equipment of sharedTools) {
          const conflicts = findAllConflicts(allOccupations, equipment, startAt, endAt);
          if (conflicts.length > 0) {
            throw new LedgerReject(
              'EQUIPMENT_CONFLICT',
              `${equipment} 在 ${new Date(startAt).toLocaleString('zh-CN')} 起 ${draft.durationMin} 分钟时段已被占用`,
              { conflict: conflicts[0], conflicts },
            );
          }
        }

        // 校验全部通过后才构造占用账与节点
        const record: PrepProcedure = { ...draft, id: procedureId };

        if (issueId) {
          const lot = await db.supplies.get(lotId);
          if (!lot) throw new LedgerReject('NO_LOT', '所选胶种批次已不存在');
          const issue: SupplyIssue = {
            id: issueId,
            qty: draft.adhesiveIssueQty ?? 0,
            operator: draft.operator,
            specimenNo: specimen.specimenNo,
            issuedAt: now,
            procedureId,
            specimenId: specimen.id,
            source: 'procedure',
            lotName: lot.name,
            lotNo: lot.lotNo,
          };
          record.adhesiveLotId = lot.id;

          if (simulateWriteFailure) {
            throw new Error('模拟写库失败：扣减未落库，事务整体回滚');
          }

          // 只追加领用记录，绝不直接改写余量；余量永远由记录重算
          await db.supplies.put({ ...lot, issues: [issue, ...lot.issues] });
        } else if (simulateWriteFailure) {
          throw new Error('模拟写库失败：事务整体回滚');
        }

        if (sharedTools.length > 0) {
          const occ: EquipmentOccupation = {
            id: newId('occ'),
            equipment: sharedTools[0],
            startAt,
            endAt,
            claimedAt: now,
            procedureId,
            nodeName: draft.nodeName,
            stepType: draft.stepType,
            operator: draft.operator,
            specimenId: specimen.id,
            specimenNo: specimen.specimenNo,
            seq: draft.seq,
            status: 'active',
          };
          occupationId = occ.id;
          record.occupationId = occ.id;
          await db.occupations.put(occ);
        }

        await db.procedures.put(record);
        return record;
      },
    );
  },

  /** 材料台账手工领用：同样按已有领用记录重算余量、校验保质期 */
  async issueManual(input: ManualIssueInput): Promise<void> {
    await db.transaction('rw', db.supplies, db.specimens, async () => {
      const lot = await db.supplies.get(input.lotId);
      if (!lot) throw new LedgerReject('NO_LOT', '批次不存在');
      const remaining = remainingQty(lot);
      if (input.qty <= 0 || input.qty > remaining) {
        throw new LedgerReject(
          'INSUFFICIENT',
          `领用数量需在 1 ~ ${remaining} ${lot.unit} 之间`,
          { remaining, unit: lot.unit },
        );
      }
      if (isExpired(lot)) {
        throw new LedgerReject('EXPIRED', `批号 ${lot.lotNo} 已过保质期，不能领用`);
      }
      const issue: SupplyIssue = {
        id: newId('iss'),
        qty: input.qty,
        operator: input.operator,
        specimenNo: input.specimenNo,
        specimenId: input.specimenId,
        issuedAt: Date.now(),
        source: 'manual',
        lotName: lot.name,
        lotNo: lot.lotNo,
      };
      await db.supplies.put({ ...lot, issues: [issue, ...lot.issues] });
    });
  },

  /**
   * 工序回退：设备占用立即作废、该工序领用立即作废，
   * 相关余量与对照说明随之失效重算（读取侧按 voided 过滤）。
   */
  async rollbackProcedure(procedureId: string): Promise<void> {
    await db.transaction('rw', db.procedures, db.supplies, db.occupations, async () => {
      const proc = await db.procedures.get(procedureId);
      if (!proc) return;
      const now = Date.now();

      await db.procedures.put({ ...proc, state: 'rolledback', finishedAt: undefined });

      if (proc.occupationId) {
        const occ = await db.occupations.get(proc.occupationId);
        if (occ) {
          await db.occupations.put({ ...occ, status: 'voided', voidedAt: now });
        }
      }
      // 兜底：按 procedureId 再扫一遍占用账
      const linked = await db.occupations.where('procedureId').equals(procedureId).toArray();
      for (const occ of linked) {
        if (occ.status === 'active') {
          await db.occupations.put({ ...occ, status: 'voided', voidedAt: now });
        }
      }

      // 作废该工序的全部有效领用（跨批次也覆盖）
      const lots = await db.supplies.toArray();
      for (const lot of lots) {
        let changed = false;
        const issues = lot.issues.map((it) => {
          if (it.procedureId === procedureId && !it.voided) {
            changed = true;
            return { ...it, voided: true };
          }
          return it;
        });
        if (changed) await db.supplies.put({ ...lot, issues });
      }
    });
  },

  /**
   * 时段改动：旧占用立即作废，按新时段重新争用；
   * 争不到（后来者）原样抛冲突，旧时段占用保留作废痕迹、工序时段不变。
   */
  async rescheduleProcedure(procedureId: string, newStartAt: number): Promise<EquipmentOccupation> {
    return db.transaction('rw', db.procedures, db.occupations, db.specimens, async () => {
      const proc = await db.procedures.get(procedureId);
      if (!proc) throw new LedgerReject('NO_SPECIMEN', '工序不存在');
      if (proc.state === 'rolledback') {
        throw new LedgerReject('EQUIPMENT_CONFLICT', '已回退工序不能改期，请先重新提交');
      }
      const equipment = proc.tools.find(isSharedEquipment);
      if (!equipment) {
        throw new LedgerReject('EQUIPMENT_CONFLICT', '该工序未占用独占设备，无需改期');
      }
      const specimen = await db.specimens.get(proc.specimenId);
      const newEndAt = newStartAt + proc.durationMin * 60000;
      const all = await db.occupations.toArray();
      const conflicts = findAllConflicts(all, equipment, newStartAt, newEndAt, procedureId);
      if (conflicts.length > 0) {
        throw new LedgerReject('EQUIPMENT_CONFLICT', '新时段仍被占用，改期未生效', {
          conflict: conflicts[0],
          conflicts,
        });
      }

      const now = Date.now();
      const newOcc: EquipmentOccupation = {
        id: newId('occ'),
        equipment,
        startAt: newStartAt,
        endAt: newEndAt,
        claimedAt: now,
        procedureId,
        nodeName: proc.nodeName,
        stepType: proc.stepType,
        operator: proc.operator,
        specimenId: proc.specimenId,
        specimenNo: specimen?.specimenNo ?? '',
        seq: proc.seq,
        status: 'active',
      };

      if (proc.occupationId) {
        const old = await db.occupations.get(proc.occupationId);
        if (old) {
          await db.occupations.put({ ...old, status: 'voided', voidedAt: now, replacedBy: newOcc.id });
        }
      }
      await db.occupations.put(newOcc);
      await db.procedures.put({ ...proc, planStart: newStartAt, occupationId: newOcc.id });
      return newOcc;
    });
  },
};

import { newId } from './id';
import { isSharedEquipment } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';
import type { EquipmentOccupation } from '../types/occupation';

/**
 * 迁移/运行期使用的宽松表结构，避免在升级事务里依赖具体 Dexie 表声明。
 */
export interface LegacyProcedureRow {
  id: string;
  specimenId: string;
  stepType: string;
  nodeName: string;
  seq: number;
  tools?: string[];
  adhesive?: string;
  durationMin?: number;
  operator?: string;
  startedAt?: number;
  state?: string;
  occupationId?: string;
  planStart?: number;
}

interface LegacySpecimenRow {
  id: string;
  specimenNo: string;
}

interface MinimalCollection<T> {
  toArray(): Promise<T[]>;
}
interface MinimalTable<T> extends MinimalCollection<T> {
  put(row: T): Promise<unknown>;
}
interface LegacyOccupationTable extends MinimalTable<EquipmentOccupation> {
  where(index: 'procedureId'): { equals(value: string): MinimalCollection<EquipmentOccupation> };
}

/**
 * 按耗时估算胶种消耗（旧工序缺领用记录时回填一条）。
 * 规则：每满 30 分钟计 1 个单位，至少 1；并保证不超过该批次当前余量。
 */
export function estimateConsumptionByDuration(durationMin: number): number {
  return Math.max(1, Math.ceil((durationMin || 0) / 30));
}

/**
 * 旧数据补齐占用账（幂等，可重复执行）：
 * 1. 用了胶种、但任何批次领用记录里都查不到该工序的，按耗时回填一条消耗；
 * 2. 占用独占设备、但占用账没有该工序记录的，补一条时段占用（已回退工序直接记为作废）。
 *
 * 同时把 planStart / 快照字段补齐到工序行。
 */
export async function backfillLegacyOccupancy(params: {
  procedures: MinimalTable<LegacyProcedureRow>;
  supplies: MinimalTable<SupplyLot>;
  specimens: MinimalCollection<LegacySpecimenRow>;
  occupations: LegacyOccupationTable;
}): Promise<{ issues: number; occupations: number }> {
  const { procedures, supplies, specimens, occupations } = params;
  const [procRows, lotRows, spmRows, occRows] = await Promise.all([
    procedures.toArray(),
    supplies.toArray(),
    specimens.toArray(),
    occupations.toArray(),
  ]);

  const specimenNoOf = new Map(spmRows.map((s) => [s.id, s.specimenNo]));
  const proceduresWithIssues = new Set(
    lotRows.flatMap((lot) => lot.issues.map((it: SupplyIssue) => it.procedureId).filter(Boolean)),
  );
  const proceduresWithOccupation = new Set(occRows.map((o) => o.procedureId));

  // 胶种名 -> 批次（同名取第一条）
  const lotByName = new Map<string, SupplyLot>();
  for (const lot of lotRows) {
    if (lot.name && !lotByName.has(lot.name)) lotByName.set(lot.name, lot);
  }

  let issueCount = 0;
  let occupationCount = 0;

  // 需要更新的批次（先在内存合并，避免同一批次多次 put）
  const lotPatch = new Map<string, SupplyIssue[]>();

  for (const proc of procRows) {
    const now = proc.startedAt ?? Date.now();
    const rolledBack = proc.state === 'rolledback';
    const specimenNo = specimenNoOf.get(proc.specimenId) ?? '历史标本';

    // 1) 材料侧回填
    if (proc.adhesive && !proceduresWithIssues.has(proc.id)) {
      const lot = lotByName.get(proc.adhesive);
      if (lot) {
        const qty = Math.min(estimateConsumptionByDuration(proc.durationMin ?? 0), Math.max(0, lot.qty));
        if (qty > 0) {
          const issue: SupplyIssue = {
            id: newId('iss'),
            qty,
            operator: proc.operator ?? '历史回填',
            specimenNo,
            issuedAt: now,
            procedureId: proc.id,
            specimenId: proc.specimenId,
            source: 'procedure',
            lotName: lot.name,
            lotNo: lot.lotNo,
            backfilled: true,
            voided: rolledBack,
          };
          lotPatch.set(lot.id, [issue, ...(lotPatch.get(lot.id) ?? lot.issues)]);
          issueCount += 1;
        }
      }
    }

    // 2) 设备侧回填
    const shared = (proc.tools ?? []).filter(isSharedEquipment);
    if (shared.length > 0 && !proceduresWithOccupation.has(proc.id)) {
      const startAt = proc.planStart ?? now;
      const duration = proc.durationMin ?? 60;
      const occ: EquipmentOccupation = {
        id: newId('occ'),
        equipment: shared[0],
        startAt,
        endAt: startAt + duration * 60000,
        claimedAt: now,
        procedureId: proc.id,
        nodeName: proc.nodeName,
        stepType: proc.stepType,
        operator: proc.operator ?? '历史回填',
        specimenId: proc.specimenId,
        specimenNo,
        seq: proc.seq,
        status: rolledBack ? 'voided' : 'active',
        voidedAt: rolledBack ? now : undefined,
        backfilled: true,
      };
      await occupations.put(occ);
      occupationCount += 1;
    }

    // 3) 工序行补齐 planStart / occupationId 占位字段（不改业务状态）
    if (proc.planStart === undefined) {
      await procedures.put({ ...proc, planStart: now });
    }
  }

  for (const [lotId, issues] of lotPatch) {
    const lot = lotRows.find((l) => l.id === lotId);
    if (lot) await supplies.put({ ...lot, issues });
  }

  return { issues: issueCount, occupations: occupationCount };
}

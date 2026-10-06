/** 占用账状态：有效占用 / 工序回退后作废 */
export type OccupationStatus = 'active' | 'voided';

/**
 * 统一占用账（设备时段侧）。
 * 工序节点、材料批次、标本档案都通过本记录确认某台设备某时段归谁；
 * 同一设备同一时段只允许一条 active 记录，先到先得。
 */
export interface EquipmentOccupation {
  id: string;
  /** 设备名称，如「真空浸渗罐」 */
  equipment: string;
  /** 时段起点（ms） */
  startAt: number;
  /** 时段终点（ms） */
  endAt: number;
  /** 提交占用的时间，先到先得按它排序 */
  claimedAt: number;
  /** 占用方（工序节点） */
  procedureId: string;
  /** 节点名称快照 */
  nodeName: string;
  /** 工序类型快照 */
  stepType: string;
  /** 责任人 */
  operator: string;
  /** 归属标本 */
  specimenId: string;
  /** 标本号快照 */
  specimenNo: string;
  /** 序号快照 */
  seq: number;
  status: OccupationStatus;
  /** 作废时间（工序回退/改期） */
  voidedAt?: number;
  /** 改期时指向替换它的新占用记录 */
  replacedBy?: string;
  /** 迁移回填标记：旧工序缺占用记录时补 */
  backfilled?: boolean;
}

/** 两个半开区间 [s1,e1) 与 [s2,e2) 是否重叠（端点相接不算冲突） */
export function isOverlap(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 < e2 && s2 < e1;
}

/**
 * 同一设备同一时段的先到者。
 * 只认 active 记录；平局（同一毫秒提交）取 claimedAt 相同下 id 较小者，保证结果确定。
 */
export function findConflictingOccupation(
  rows: EquipmentOccupation[],
  equipment: string,
  startAt: number,
  endAt: number,
  excludeProcedureId?: string,
): EquipmentOccupation | undefined {
  return rows
    .filter(
      (r) =>
        r.status === 'active' &&
        r.equipment === equipment &&
        r.procedureId !== excludeProcedureId &&
        isOverlap(startAt, endAt, r.startAt, r.endAt),
    )
    .sort((a, b) => a.claimedAt - b.claimedAt || (a.id < b.id ? -1 : 1))[0];
}

/** 全部冲突占用（含先到者之外的并行占用），用于当场展示占用方清单 */
export function findAllConflicts(
  rows: EquipmentOccupation[],
  equipment: string,
  startAt: number,
  endAt: number,
  excludeProcedureId?: string,
): EquipmentOccupation[] {
  return rows
    .filter(
      (r) =>
        r.status === 'active' &&
        r.equipment === equipment &&
        r.procedureId !== excludeProcedureId &&
        isOverlap(startAt, endAt, r.startAt, r.endAt),
    )
    .sort((a, b) => a.startAt - b.startAt || a.claimedAt - b.claimedAt);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** yyyy-MM-dd HH:mm */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** <input type="datetime-local"> 用的值 */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 值转回 ms */
export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}

/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 领用来源：工序节点提交时的占用，或材料台账里手工领用 */
export type IssueSource = 'procedure' | 'manual';

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /**
   * 初始在库数量（入库时登记）。
   * 当前余量永远以「初始量 − 有效领用记录」实时重算，
   * 不再把余量直接写回该字段，避免多窗口各扣一遍。
   */
  qty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 领用记录（同一份占用账的材料侧） */
  issues: SupplyIssue[];
}

/** 领用登记（材料批次的占用明细） */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
  /** 归属工序节点；手工领用为空 */
  procedureId?: string;
  /** 归属标本；手工领用且未关联时为空 */
  specimenId?: string;
  /** 领用方式：工序提交占用 / 手工领用 */
  source?: IssueSource;
  /** 批次快照，便于对照说明在改名/删批次后仍可读 */
  lotName?: string;
  lotNo?: string;
  /** 是否作废（工序回退后该笔领用立即失效，余量随之恢复） */
  voided?: boolean;
  /** 回填标记：旧工序缺领用记录，按耗时补一条消耗 */
  backfilled?: boolean;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues'>;

/** 仅统计有效（未作废）的领用数量 */
export function issuedQty(lot: SupplyLot): number {
  return lot.issues.reduce((sum, it) => sum + (it.voided ? 0 : it.qty), 0);
}

/**
 * 按这批已有的领用记录重算当前余量。
 * 多窗口同时打开时，以库里的领用记录为唯一准绳。
 */
export function remainingQty(lot: SupplyLot): number {
  return Math.max(0, lot.qty - issuedQty(lot));
}

/** 余量是否低于阈值（按重算余量判断，不再直接读 qty） */
export function isLowStock(lot: SupplyLot): boolean {
  return remainingQty(lot) <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}

/** 是否已过保质期 */
export function isExpired(lot: SupplyLot, now = Date.now()): boolean {
  return shelfLifeLeftDays(lot, now) < 0;
}

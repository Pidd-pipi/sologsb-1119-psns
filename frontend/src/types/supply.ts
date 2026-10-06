/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 领用记录状态：正常 / 已随工序回退作废 */
export type IssueStatus = 'active' | 'voided';

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /** 入库总量（账上的来源量，余量一律按 入库量 - 有效领用 重算） */
  stockQty: number;
  /** 历史快照字段：最后一次重算出的余量，仅用于兼容旧视图；权威余量见 lotBalance */
  qty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 领用记录（同一批次的占用流水） */
  issues: SupplyIssue[];
}

/** 领用登记 */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
  /** 关联工序节点；手工领用可留空 */
  procedureId?: string;
  /** 关联标本档案 */
  specimenId?: string;
  status: IssueStatus;
  /** 作废原因，如工序回退 */
  voidReason?: string;
  voidedAt?: number;
  /** 旧数据迁移时按耗时回填的标记 */
  backfilled?: boolean;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues' | 'qty'>;

/** 有效领用合计（作废记录不再占余量） */
export function issuedQty(lot: SupplyLot): number {
  return lot.issues
    .filter((it) => it.status !== 'voided')
    .reduce((sum, it) => sum + (Number.isFinite(it.qty) ? it.qty : 0), 0);
}

/**
 * 按这批已有的领用记录重算余量：入库量 - 有效领用。
 * 任何窗口提交前都以库里最新记录为准重新算，不采信内存旧余量。
 */
export function lotBalance(lot: SupplyLot): number {
  const stock = Number.isFinite(lot.stockQty) ? lot.stockQty : lot.qty;
  return Math.max(0, stock - issuedQty(lot));
}

/** 是否低量（按重算余量判定） */
export function isLowStock(lot: SupplyLot): boolean {
  return lotBalance(lot) <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}

/** 该批次是否已过保质期 */
export function isExpired(lot: SupplyLot, now = Date.now()): boolean {
  return shelfLifeLeftDays(lot, now) < 0;
}

/** 工具类批次视为可预约设备（真空浸渗罐、超声波清洗机等） */
export function isEquipmentLot(lot: SupplyLot): boolean {
  return lot.kind === '工具';
}

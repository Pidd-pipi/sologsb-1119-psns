import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { manualIssue } from '../utils/ledger';
import { notifyOccupancyChanged } from '../utils/multiTab';
import { lotBalance, type SupplyIssue, type SupplyLot, type SupplyLotDraft } from '../types/supply';

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 手工领用：走占用账事务，按最新流水重算余量、校保质期 */
  issue: (
    id: string,
    payload: Omit<SupplyIssue, 'id' | 'issuedAt' | 'status'> & { specimenId?: string },
  ) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async add(draft) {
    // 新批次入库量即初始余量，领用流水为空
    const record: SupplyLot = {
      ...draft,
      id: newId('sup'),
      qty: draft.stockQty,
      issues: [],
    };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    notifyOccupancyChanged({ type: 'supply-changed', at: Date.now() });
    return record;
  },
  async issue(id, payload) {
    await manualIssue(id, {
      qty: payload.qty,
      operator: payload.operator,
      specimenNo: payload.specimenNo,
      specimenId: payload.specimenId,
    });
    // 以库里的最新记录回写，绝不拿内存余量自行扣减
    const fresh = await db.supplies.get(id);
    if (fresh) {
      set({ items: get().items.map((it) => (it.id === id ? fresh : it)) });
    }
    notifyOccupancyChanged({ type: 'supply-issued', at: Date.now() });
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));

/** 供页面展示的重算余量（避免页面直接拼公式） */
export { lotBalance };

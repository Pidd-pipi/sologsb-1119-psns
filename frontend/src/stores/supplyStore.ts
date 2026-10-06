import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { ledger } from '../utils/ledger';
import { remainingQty, type SupplyIssue, type SupplyLot, type SupplyLotDraft } from '../types/supply';

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 手工领用：按已有领用记录重算余量、校验保质期，事务内原子落库 */
  issue: (
    id: string,
    payload: Omit<SupplyIssue, 'id' | 'issuedAt' | 'source' | 'lotName' | 'lotNo'>,
  ) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
  remainingOf: (id: string) => number;
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
    const record: SupplyLot = { ...draft, id: newId('sup'), issues: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async issue(id, payload) {
    await ledger.issueManual({
      lotId: id,
      qty: payload.qty,
      operator: payload.operator,
      specimenNo: payload.specimenNo,
      specimenId: payload.specimenId,
    });
    // 事务提交后重新装载，余量以库里的领用记录为准（多窗口各开也不重复扣）
    await get().load();
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
  remainingOf(id) {
    const lot = get().items.find((it) => it.id === id);
    return lot ? remainingQty(lot) : 0;
  },
}));

import { create } from 'zustand';
import { db } from '../utils/db';
import { findConflictingOccupation, type EquipmentOccupation } from '../types/occupation';

interface OccupationState {
  items: EquipmentOccupation[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 某设备某时段当前的先到占用方（无则 undefined） */
  holderOf: (equipment: string, startAt: number, endAt: number, excludeProcedureId?: string) => EquipmentOccupation | undefined;
}

export const useOccupationStore = create<OccupationState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.occupations.toArray();
    items.sort((a, b) => a.startAt - b.startAt || a.claimedAt - b.claimedAt);
    set({ items, loaded: true });
  },
  holderOf(equipment, startAt, endAt, excludeProcedureId) {
    return findConflictingOccupation(get().items, equipment, startAt, endAt, excludeProcedureId);
  },
}));

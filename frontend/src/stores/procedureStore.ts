import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { rescheduleProcedure, rollbackProcedure } from '../utils/ledger';
import { notifyOccupancyChanged } from '../utils/multiTab';
import type { PrepProcedure, PrepProcedureDraft } from '../types/procedure';

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 仅供无占用场景的兜底；带材料/设备占用的新建请走 ledger.createProcedureWithOccupancy */
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  rollback: (id: string, reason?: string) => Promise<PrepProcedure>;
  reschedule: (id: string, planStartAt: number) => Promise<PrepProcedure>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: PrepProcedure = { ...draft, id: newId('prc') };
    await db.procedures.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async finish(id) {
    // 完成节点不改动占用账（设备时段与领用流水保持），无需广播
    const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async rollback(id, reason) {
    const next = await rollbackProcedure(id, reason);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
    // 回退后余量与占用立即失效，其它窗口同步重算
    notifyOccupancyChanged({ type: 'procedure-rolledback', at: Date.now() });
    return next;
  },
  async reschedule(id, planStartAt) {
    const next = await rescheduleProcedure({ id, planStartAt });
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
    notifyOccupancyChanged({ type: 'procedure-rescheduled', at: Date.now() });
    return next;
  },
  async remove(id) {
    await db.procedures.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
    notifyOccupancyChanged({ type: 'procedure-rolledback', at: Date.now() });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));

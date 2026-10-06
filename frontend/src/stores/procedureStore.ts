import { create } from 'zustand';
import { db } from '../utils/db';
import { ledger } from '../utils/ledger';
import type { PrepProcedure, PrepProcedureDraft } from '../types/procedure';

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 走统一占用账事务：校验余量/保质期/设备冲突后原子落库 */
  submit: (draft: PrepProcedureDraft, simulateWriteFailure?: boolean) => Promise<PrepProcedure>;
  finish: (id: string) => Promise<void>;
  /** 回退：作废占用与领用，余量与对照立即重算 */
  rollback: (id: string) => Promise<void>;
  /** 改期：旧占用作废、新时段重新争用 */
  reschedule: (id: string, newStartAt: number) => Promise<void>;
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
  async submit(draft, simulateWriteFailure) {
    const record = await ledger.submitProcedure({ draft, simulateWriteFailure });
    set({ items: [...get().items, record] });
    return record;
  },
  async finish(id) {
    const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async rollback(id) {
    await ledger.rollbackProcedure(id);
    await get().load();
  },
  async reschedule(id, newStartAt) {
    await ledger.rescheduleProcedure(id, newStartAt);
    await get().load();
  },
  async remove(id) {
    await db.procedures.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));

// 测试用 IndexedDB / localStorage polyfill，必须在 Dexie 加载前执行
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

(globalThis as any).indexedDB = new IDBFactory();
(globalThis as any).IDBKeyRange = IDBKeyRange;
(globalThis as any).localStorage = {
  _m: new Map<string, string>(),
  getItem(k: string) {
    return this._m.has(k) ? (this._m.get(k) as string) : null;
  },
  setItem(k: string, v: string) {
    this._m.set(k, v);
  },
  removeItem(k: string) {
    this._m.delete(k);
  },
};

/**
 * 多窗口占用账同步：技师各开各的窗口时，任一窗口改写占用账后，
 * 其余窗口立即收到通知并重新从 IndexedDB 拉取最新账本。
 * 优先用 BroadcastChannel，不支持时退化为 localStorage storage 事件。
 */
const CHANNEL_NAME = 'gbfossilprep:occupancy';
const LS_PING_KEY = 'gbfossilprep:occupancy-ping';

export type OccupancyEvent =
  | { type: 'procedure-created'; at: number }
  | { type: 'procedure-rolledback'; at: number }
  | { type: 'procedure-rescheduled'; at: number }
  | { type: 'supply-issued'; at: number }
  | { type: 'supply-changed'; at: number };

type Listener = (e: OccupancyEvent) => void;

let channel: BroadcastChannel | null = null;
const listeners = new Set<Listener>();

function dispatch(e: OccupancyEvent) {
  listeners.forEach((fn) => {
    try {
      fn(e);
    } catch {
      /* 忽略单个订阅者异常 */
    }
  });
}

if (typeof window !== 'undefined') {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (msg: MessageEvent<OccupancyEvent>) => dispatch(msg.data);
  } else {
    window.addEventListener('storage', (ev) => {
      if (ev.key === LS_PING_KEY && ev.newValue) {
        try {
          dispatch(JSON.parse(ev.newValue) as OccupancyEvent);
        } catch {
          /* 忽略无法解析的 ping */
        }
      }
    });
  }
}

/** 广播占用账变更（其它窗口会收到；本窗口不回声） */
export function notifyOccupancyChanged(e: OccupancyEvent): void {
  if (channel) {
    channel.postMessage(e);
  } else if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LS_PING_KEY, JSON.stringify(e));
    } catch {
      /* localStorage 不可用时仅本窗口生效 */
    }
  }
}

/** 订阅其它窗口的占用账变更 */
export function subscribeOccupancy(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

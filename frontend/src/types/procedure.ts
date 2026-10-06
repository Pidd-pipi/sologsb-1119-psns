/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

/** 各工序类型适用的工具、磨料、胶种候选（表单动态字段用） */
export const STEP_FIELD_MAP: Record<
  StepType,
  { tools: string[]; abrasives: string[]; adhesives: string[]; needConc: boolean }
> = {
  清修: {
    tools: ['气动笔', '剔针', '超声波清洗机', '软毛刷'],
    abrasives: ['400 目', '800 目', '1200 目'],
    adhesives: [],
    needConc: false,
  },
  加固: {
    tools: ['渗透滴管', '真空浸渗罐', '加热台'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '环氧树脂 E44'],
    needConc: true,
  },
  粘接: {
    tools: ['点胶针', '夹持架', '热风枪'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '动物胶'],
    needConc: true,
  },
  补配: {
    tools: ['刮刀', '雕刻刀', '石膏模'],
    abrasives: ['600 目', '1000 目'],
    adhesives: ['环氧树脂 E44', 'Paraloid B-72'],
    needConc: true,
  },
  翻模: {
    tools: ['硅胶模具', '真空脱泡机', '石膏桶'],
    abrasives: [],
    adhesives: ['硅橡胶', '石膏浆料'],
    needConc: false,
  },
};

/** 工序节点状态 */
export type ProcedureState = 'pending' | 'done' | 'rolledback';

/** 设备时段占用（一道工序对一台工具类批次的占用账，与工序节点、标本档案同一份） */
export interface EquipmentBooking {
  /** 被占用的材料批次（设备）id */
  lotId: string;
  /** 设备名（冗余存，列表展示免联查） */
  lotName: string;
  /** 批号 */
  lotNo: string;
  /** 占用开始时刻（含时段日期，绝对时间戳） */
  startAt: number;
  /** 占用结束时刻 */
  endAt: number;
  /** 提交占用的先后序号，冲突时只留先到者 */
  claimedAt: number;
  /** 责任人 */
  operator: string;
  /** 标本号（冗余，用于当场显示占用方） */
  specimenNo: string;
}

/** 修复工序 */
export interface PrepProcedure {
  id: string;
  specimenId: string;
  stepType: StepType;
  /** 节点名称 */
  nodeName: string;
  /** 序号，不得跳号 */
  seq: number;
  /** 工具 */
  tools: string[];
  /** 磨料目数 */
  abrasive: string;
  /** 胶种 */
  adhesive: string;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 耗时 min */
  durationMin: number;
  /** 环境温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  rh: number;
  photoBeforeIds: string[];
  photoAfterIds: string[];
  operator: string;
  startedAt: number;
  state: ProcedureState;
  finishedAt?: number;
  /**
   * 计划占用时段开始（设备排程用）。
   * 与 startedAt 分开：startedAt 是登记时刻，planStartAt 是技师实际预约的开罐时段。
   */
  planStartAt?: number;
  /** 设备时段占用账，按 tools 中命中的工具类批次登记 */
  bookings?: EquipmentBooking[];
  /** 提交时命中过的设备冲突（回退后随重算清空） */
  bookingConflict?: string;
  /** 领用的胶种批次（写入同一份占用账：供应批次 issues 中回写 procedureId） */
  adhesiveLotId?: string;
  /** 领用磨料批次 */
  abrasiveLotId?: string;
  /** 领用数量（胶种，单位与批次一致） */
  adhesiveQty?: number;
  /** 领用数量（磨料） */
  abrasiveQty?: number;
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;

/** 两个半开时段是否重叠（边界相接不算冲突） */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

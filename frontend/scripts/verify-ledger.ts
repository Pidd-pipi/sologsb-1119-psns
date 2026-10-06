// 占用账事务行为验证（Node + fake-indexeddb），用 esbuild 临时打包运行，不进产物
import './fake-idb';

import { db, ensureSeedData } from '../src/utils/db';
import { ledger, LedgerReject } from '../src/utils/ledger';
import { remainingQty } from '../src/types/supply';
import { backfillLegacyOccupancy, estimateConsumptionByDuration } from '../src/utils/backfill';
import type { PrepProcedureDraft } from '../src/types/procedure';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

async function resetDb() {
  // fake-indexeddb：删除数据库重建
  await db.delete();
  await db.open();
  await ensureSeedData();
}

async function seedExtra(specimen: any) {
  // 新增一件标本，用于两道工序争同一设备
  await db.specimens.put({
    id: specimen.id,
    specimenNo: specimen.no,
    taxon: '测试种',
    horizon: 'h',
    locality: 'l',
    lithology: '岩',
    matrixHardness: 3,
    dimensions: '10x10x10',
    weight: 100,
    storageBox: 'X',
    status: '待清修',
    createdAt: Date.now(),
  });
}

function makeDraft(over: Partial<PrepProcedureDraft> & { specimenId: string }): PrepProcedureDraft {
  return {
    stepType: '加固',
    nodeName: '测试加固',
    seq: 3,
    tools: ['渗透滴管', '真空浸渗罐'],
    abrasive: '',
    adhesive: 'Paraloid B-72',
    adhesiveConc: 5,
    adhesiveLotId: 'seed-lot-b72',
    adhesiveIssueQty: 1,
    durationMin: 60,
    planStart: Date.now() + 2 * 86400000,
    tempC: 22,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '周二哥',
    startedAt: Date.now(),
    state: 'pending',
    ...over,
  };
}

async function main() {
  await resetDb();
  const allSpecimens = await db.specimens.toArray();
  const spmA = allSpecimens.find((s) => s.specimenNo === 'FP-2024-0031')!;
  const spmB = { id: 'spm-test-b', no: 'FP-TEST-9' };
  await seedExtra(spmB);

  // 1. 基础：种子数据余量 = 4 - 1 = 3
  const lot = await db.supplies.get('seed-lot-b72');
  check('种子批次余量按领用记录重算 = 3', remainingQty(lot!) === 3, `got ${remainingQty(lot!)}`);

  // 2. 余量不足退回：一次领 10 瓶
  let errCode = '';
  try {
    await ledger.submitProcedure({ draft: makeDraft({ specimenId: spmB.id, adhesiveIssueQty: 10, seq: 1 }) });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
  }
  check('余量不足时工序被退回（INSUFFICIENT）', errCode === 'INSUFFICIENT', errCode);
  const lotAfterReject = await db.supplies.get('seed-lot-b72');
  check('退回后余量不变（仍 3）', remainingQty(lotAfterReject!) === 3);
  check('退回后没有工序落库', (await db.procedures.where('specimenId').equals(spmB.id).count()) === 0);
  check('退回后没有设备占用', (await db.occupations.where('specimenId').equals(spmB.id).count()) === 0);

  // 3. 过期退回：加一条已过期胶种批次
  const expiredLotId = 'lot-expired';
  await db.supplies.put({
    id: expiredLotId,
    name: '过期胶',
    kind: '胶种',
    spec: 'x',
    lotNo: 'OLD-1',
    qty: 5,
    unit: '瓶',
    openedAt: Date.now() - 400 * 86400000,
    shelfLifeMonths: 1,
    lowThreshold: 1,
    issues: [],
  });
  errCode = '';
  try {
    await ledger.submitProcedure({
      draft: makeDraft({ specimenId: spmB.id, seq: 1, adhesiveLotId: expiredLotId, adhesive: '过期胶' }),
    });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
  }
  check('过保质期时工序被退回（EXPIRED）', errCode === 'EXPIRED', errCode);

  // 4. 设备先到先得：两道工序同一时段
  const slot = Date.now() + 3 * 86400000;
  const first = await ledger.submitProcedure({
    draft: makeDraft({ specimenId: spmA.id, seq: 3, planStart: slot, operator: '甲技师', nodeName: '甲的加固' }),
  });
  check('第一道工序提交成功并登记设备占用', !!first.occupationId);
  errCode = '';
  let rejectHolder: any;
  try {
    await ledger.submitProcedure({
      draft: makeDraft({ specimenId: spmB.id, seq: 1, planStart: slot + 5 * 60000, operator: '乙技师', nodeName: '乙的加固' }),
    });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
    rejectHolder = e instanceof LedgerReject ? e.conflict : undefined;
  }
  check('同一时段后到工序被退回（EQUIPMENT_CONFLICT）', errCode === 'EQUIPMENT_CONFLICT', errCode);
  check('退回信息当场给出先到占用方责任人', rejectHolder?.operator === '甲技师', JSON.stringify(rejectHolder));
  check('退回信息含标本号与节点名', rejectHolder?.specimenNo === spmA.specimenNo && rejectHolder?.nodeName === '甲的加固');
  const activeAtSlot = (await db.occupations.toArray()).filter(
    (o) => o.equipment === '真空浸渗罐' && o.status === 'active' && o.startAt === slot,
  );
  check('同一时段只留先到的一条占用', activeAtSlot.length === 1 && activeAtSlot[0].procedureId === first.id);

  // 5. 写库失败回滚：模拟扣减失败 → 无节点、无领用、余量恢复
  const remainBefore = remainingQty((await db.supplies.get('seed-lot-b72'))!);
  errCode = '';
  try {
    await ledger.submitProcedure({
      draft: makeDraft({ specimenId: spmB.id, seq: 1, planStart: slot + 10 * 86400000, operator: '乙技师' }),
      simulateWriteFailure: true,
    });
  } catch (e) {
    errCode = e instanceof Error ? e.message : String(e);
  }
  check('模拟写库失败抛出错误', /写库失败/.test(errCode), errCode);
  const remainAfterFail = remainingQty((await db.supplies.get('seed-lot-b72'))!);
  check('写库失败后余量恢复原样', remainAfterFail === remainBefore, `${remainAfterFail} vs ${remainBefore}`);
  check('写库失败后无工序残留', (await db.procedures.where('specimenId').equals(spmB.id).count()) === 0);
  check('写库失败后无设备占用残留', (await db.occupations.where('specimenId').equals(spmB.id).count()) === 0);

  // 6. 回退：作废占用 + 领用，余量恢复，然后乙能占同一时段
  const remainBeforeRollback = remainingQty((await db.supplies.get('seed-lot-b72'))!);
  await ledger.rollbackProcedure(first.id);
  const firstProc = await db.procedures.get(first.id);
  check('回退后工序状态为 rolledback', firstProc?.state === 'rolledback');
  const firstOcc = await db.occupations.get(first.occupationId!);
  check('回退后设备占用 voided', firstOcc?.status === 'voided');
  const remainAfterRollback = remainingQty((await db.supplies.get('seed-lot-b72'))!);
  check('回退后该工序领用作废、余量恢复', remainAfterRollback === remainBeforeRollback + 1);
  // 乙现在能占原时段
  const second = await ledger.submitProcedure({
    draft: makeDraft({ specimenId: spmB.id, seq: 1, planStart: slot, operator: '乙技师', nodeName: '乙的加固' }),
  });
  check('回退释放时段后，新工序可占用同一时段', !!second.occupationId);

  // 7. 改期：旧占用作废 + 新占用 active，冲突时不改
  const newSlot = slot + 6 * 86400000;
  await ledger.rescheduleProcedure(second.id, newSlot);
  const secondProc = await db.procedures.get(second.id);
  const newOcc = await db.occupations.get(secondProc!.occupationId!);
  const oldOcc = await db.occupations.get(second.occupationId!);
  check('改期后工序指向新时段', secondProc?.planStart === newSlot);
  check('改期后新占用 active', newOcc?.status === 'active' && newOcc.startAt === newSlot);
  check('改期后旧占用 voided 且记 replacedBy', oldOcc?.status === 'voided' && oldOcc.replacedBy === newOcc?.id);
  // 再建一道占住另一时段，改期过去应失败且保持现状
  const third = await ledger.submitProcedure({
    draft: makeDraft({ specimenId: spmA.id, seq: 4, planStart: slot + 100 * 86400000, operator: '丙', nodeName: '丙加固' }),
  });
  const targetSlot = slot + 100 * 86400000;
  errCode = '';
  try {
    await ledger.rescheduleProcedure(second.id, targetSlot);
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
  }
  check('改期撞上先到占用时被拒', errCode === 'EQUIPMENT_CONFLICT', errCode);
  const unchanged = await db.procedures.get(second.id);
  check('改期失败后原时段保持不变', unchanged?.planStart === newSlot);
  await ledger.rollbackProcedure(third.id);

  // 8. 手工领用：不足/过期/正常
  errCode = '';
  try {
    await ledger.issueManual({ lotId: 'seed-lot-b72', qty: 999, operator: '库管', specimenNo: 'FP-TEST-9' });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
  }
  check('手工领用超量被拒', errCode === 'INSUFFICIENT', errCode);
  errCode = '';
  try {
    await ledger.issueManual({ lotId: expiredLotId, qty: 1, operator: '库管', specimenNo: 'FP-TEST-9' });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
  }
  check('手工领用过保质期批次被拒', errCode === 'EXPIRED', errCode);

  // 9. 多窗口重复扣：同一批次在同一时刻由两个"窗口"提交，均按库里记录重算 → 第二个超量退回
  const windowSlotA = slot + 80 * 86400000;
  const windowSlotB = slot + 81 * 86400000;
  let freshA: any;
  errCode = '';
  try {
    freshA = await ledger.submitProcedure({
      draft: makeDraft({ specimenId: spmA.id, seq: 5, planStart: windowSlotA, adhesiveIssueQty: 2, operator: '窗A' }),
    });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
  }
  check('窗口A先提交成功', errCode === '' && !!freshA, errCode);
  errCode = '';
  let errMsg = '';
  try {
    await ledger.submitProcedure({
      draft: makeDraft({
        specimenId: spmB.id,
        seq: 2,
        planStart: windowSlotB,
        adhesiveIssueQty: 2,
        operator: '窗B',
      }),
    });
  } catch (e) {
    errCode = e instanceof LedgerReject ? e.code : String(e);
    errMsg = e instanceof Error ? e.message : '';
  }
  check('后保存窗口按最新领用记录重算 → 不会重复扣（超量退回）', errCode === 'INSUFFICIENT', `${errCode} ${errMsg}`);
  await ledger.rollbackProcedure(freshA.id);

  // 10. 旧数据回填：删库造旧结构（无 issue 关联、无 occupation、无 planStart）
  await db.delete();
  await db.open();
  await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, db.occupations, async () => {
    await db.specimens.put({
      id: 'spm-old',
      specimenNo: 'FP-OLD-1',
      taxon: '旧种',
      horizon: 'h',
      locality: 'l',
      lithology: '岩',
      matrixHardness: 2,
      dimensions: '1x1x1',
      weight: 1,
      storageBox: 'Z',
      status: '修复中',
      createdAt: Date.now() - 100000,
    });
    // @ts-expect-error 模拟旧版缺字段行
    await db.procedures.put({
      id: 'prc-old',
      specimenId: 'spm-old',
      stepType: '加固',
      nodeName: '旧加固',
      seq: 1,
      tools: ['渗透滴管', '真空浸渗罐'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 5,
      durationMin: 90,
      tempC: 22,
      rh: 45,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '老师傅',
      startedAt: Date.now() - 50000,
      state: 'pending',
    });
    await db.supplies.put({
      id: 'lot-old',
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: 's',
      lotNo: 'B72-OLD',
      qty: 10,
      unit: '瓶',
      openedAt: Date.now() - 1000,
      shelfLifeMonths: 36,
      lowThreshold: 1,
      issues: [],
    });
  });

  const r = await backfillLegacyOccupancy({
    procedures: db.procedures,
    supplies: db.supplies,
    specimens: db.specimens,
    occupations: db.occupations,
  });
  check('旧工序按耗时回填 1 条消耗（90min → 3 瓶）', r.issues === 1, `got ${r.issues}`);
  check('回填占用 1 条设备时段', r.occupations === 1, `got ${r.occupations}`);
  const oldLot = await db.supplies.get('lot-old');
  const backIssue = oldLot!.issues[0];
  check('回填领用数量 = ceil(90/30) = 3', backIssue.qty === 3, `got ${backIssue.qty}`);
  check('回填领用带 backfilled 标记并关联工序', backIssue.backfilled === true && backIssue.procedureId === 'prc-old');
  check('回填后余量 = 10 - 3 = 7', remainingQty(oldLot!) === 7, `got ${remainingQty(oldLot!)}`);
  const oldProc = await db.procedures.get('prc-old');
  check('旧工序补齐 planStart', typeof oldProc?.planStart === 'number');
  const oldOccs = await db.occupations.where('procedureId').equals('prc-old').toArray();
  check('旧工序占用记录 active 且责任人快照正确', oldOccs[0]?.status === 'active' && oldOccs[0]?.operator === '老师傅');

  // 幂等：再跑一遍不应新增
  const r2 = await backfillLegacyOccupancy({
    procedures: db.procedures,
    supplies: db.supplies,
    specimens: db.specimens,
    occupations: db.occupations,
  });
  check('回填幂等：第二次不新增任何记录', r2.issues === 0 && r2.occupations === 0, JSON.stringify(r2));

  // 已回退旧工序回填应为 voided
  await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.occupations, async () => {
    // @ts-expect-error 旧行
    await db.procedures.put({
      id: 'prc-old-rb',
      specimenId: 'spm-old',
      stepType: '加固',
      nodeName: '旧加固-已回退',
      seq: 2,
      tools: ['真空浸渗罐'],
      adhesive: 'Paraloid B-72',
      durationMin: 30,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '老师傅',
      startedAt: Date.now() - 40000,
      state: 'rolledback',
    });
  });
  await backfillLegacyOccupancy({
    procedures: db.procedures,
    supplies: db.supplies,
    specimens: db.specimens,
    occupations: db.occupations,
  });
  const rbOccs = await db.occupations.where('procedureId').equals('prc-old-rb').toArray();
  check('已回退旧工序回填的占用直接 voided', rbOccs[0]?.status === 'voided');
  const rbLot = await db.supplies.get('lot-old');
  const rbIssue = rbLot!.issues.find((i) => i.procedureId === 'prc-old-rb');
  check('已回退旧工序回填的领用直接 voided（不占余量）', rbIssue?.voided === true && remainingQty(rbLot!) === 7);

  check('耗时估算函数边界：0min→1、1min→1、30min→1、31min→2',
    estimateConsumptionByDuration(0) === 1 &&
      estimateConsumptionByDuration(1) === 1 &&
      estimateConsumptionByDuration(30) === 1 &&
      estimateConsumptionByDuration(31) === 2);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

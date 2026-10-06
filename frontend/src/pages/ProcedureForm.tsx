import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, rangesOverlap, type EquipmentBooking, type StepType } from '../types/procedure';
import { isExpired, lotBalance, type SupplyLot } from '../types/supply';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';
import { createProcedureWithOccupancy, LedgerError, toDatetimeLocalValue } from '../utils/ledger';
import { notifyOccupancyChanged } from '../utils/multiTab';

const DRAFT_KEY = 'gbfossilprep:procedure-draft';

interface SlotConflict {
  lotName: string;
  lotNo: string;
  holderNodeName: string;
  holderSpecimenNo: string;
  holderOperator: string;
  rangeText: string;
}

interface SavedDraft {
  stepType: StepType;
  nodeName: string;
  seq: number;
  tools: string[];
  equipmentLotIds: string[];
  abrasive: string;
  abrasiveLotId: string;
  abrasiveQty: number;
  adhesive: string;
  adhesiveLotId: string;
  adhesiveQty: number;
  durationMin: number;
  tempC: number;
  rh: number;
  operator: string;
  planStartAt: string;
  withPhotos: boolean;
}

function fmtRange(b: EquipmentBooking): string {
  const f = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return `${f(b.startAt)} ~ ${f(b.endAt)}（${b.specimenNo} · ${b.operator}）`;
}

/** /procedures/new 新建工序节点：材料领用 + 设备时段占用走同一份占用账 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const procedures = useProcedureStore((s) => s.items);
  const addProcedureDone = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const reschedule = useProcedureStore((s) => s.reschedule);
  const lots = useSupplyStore((s) => s.items);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [equipmentLotIds, setEquipmentLotIds] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [abrasiveLotId, setAbrasiveLotId] = useState('');
  const [abrasiveQty, setAbrasiveQty] = useState(1);
  const [adhesive, setAdhesive] = useState('');
  const [adhesiveLotId, setAdhesiveLotId] = useState('');
  const [adhesiveQty, setAdhesiveQty] = useState(1);
  const [adhesiveConcValue, setAdhesiveConcValue] = useState(5);
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [planStartAt, setPlanStartAt] = useState(toDatetimeLocalValue(Date.now()));
  const [withPhotos, setWithPhotos] = useState(true);
  const [error, setError] = useState('');
  const [conflictAlert, setConflictAlert] = useState<SlotConflict | null>(null);
  const [toast, setToast] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rescheduleTarget, setRescheduleTarget] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState('');

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  // 草稿自动留存：切走/刷新后仍能接着改
  useEffect(() => {
    if (!nodeName.trim() && !operator.trim()) return;
    const saved: SavedDraft = {
      stepType, nodeName, seq, tools, equipmentLotIds,
      abrasive, abrasiveLotId, abrasiveQty,
      adhesive, adhesiveLotId, adhesiveQty,
      durationMin, tempC, rh, operator, planStartAt, withPhotos,
    };
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(saved));
    } catch {
      /* 草稿不可写时忽略 */
    }
  }, [stepType, nodeName, seq, tools, equipmentLotIds, abrasive, abrasiveLotId, abrasiveQty,
      adhesive, adhesiveLotId, adhesiveQty, durationMin, tempC, rh, operator, planStartAt, withPhotos]);

  // 进入页面时若有上次未提交草稿，提示恢复
  const [resumeHint, setResumeHint] = useState<SavedDraft | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (raw) setResumeHint(JSON.parse(raw) as SavedDraft);
    } catch {
      /* 忽略损坏草稿 */
    }
  }, []);

  const applyDraft = (d: SavedDraft) => {
    setStepType(d.stepType);
    setNodeName(d.nodeName);
    setSeq(d.seq);
    setTools(d.tools);
    setEquipmentLotIds(d.equipmentLotIds);
    setAbrasive(d.abrasive);
    setAbrasiveLotId(d.abrasiveLotId);
    setAbrasiveQty(d.abrasiveQty);
    setAdhesive(d.adhesive);
    setAdhesiveLotId(d.adhesiveLotId);
    setAdhesiveQty(d.adhesiveQty);
    setDurationMin(d.durationMin);
    setTempC(d.tempC);
    setRh(d.rh);
    setOperator(d.operator);
    setPlanStartAt(d.planStartAt);
    setWithPhotos(d.withPhotos);
    setResumeHint(null);
  };

  // 选中工具里命中的设备批次（工具类材料 = 可预约设备，如真空浸渗罐）
  const equipmentLots = useMemo(
    () => lots.filter((lot) => lot.kind === '工具' && tools.includes(lot.name)),
    [lots, tools],
  );

  // 只有唯一同名称设备时自动勾上，多台时交给技师点名
  useEffect(() => {
    setEquipmentLotIds((prev) => {
      const valid = prev.filter((id) => equipmentLots.some((l) => l.id === id));
      const auto = equipmentLots.filter((l) => !prev.includes(l.id) &&
        equipmentLots.filter((x) => x.name === l.name).length === 1).map((l) => l.id);
      return [...valid, ...auto];
    });
  }, [equipmentLots]);

  const adhesiveLots = useMemo(
    () => (adhesive ? lots.filter((l) => l.kind === '胶种' && l.name === adhesive) : []),
    [lots, adhesive],
  );
  const abrasiveLots = useMemo(
    () => (abrasive ? lots.filter((l) => l.kind === '磨料' && l.name === abrasive) : []),
    [lots, abrasive],
  );

  const chosenAdhesiveLot = lots.find((l) => l.id === adhesiveLotId);
  const chosenAbrasiveLot = lots.find((l) => l.id === abrasiveLotId);

  const planTs = useMemo(() => {
    const t = new Date(planStartAt).getTime();
    return Number.isFinite(t) ? t : Date.now();
  }, [planStartAt]);
  const planEnd = planTs + Math.max(1, durationMin) * 60000;

  // 实时预览：当前所选设备 + 时段已被谁占用（当场显示占用方与责任人）
  const slotConflicts = useMemo<SlotConflict[]>(() => {
    const out: SlotConflict[] = [];
    for (const lotId of equipmentLotIds) {
      const lot = lots.find((l) => l.id === lotId);
      if (!lot) continue;
      for (const proc of procedures) {
        if (proc.state === 'rolledback') continue;
        const held = (proc.bookings ?? []).find((b) => b.lotId === lotId);
        if (!held) continue;
        if (rangesOverlap(planTs, planEnd, held.startAt, held.endAt)) {
          out.push({
            lotName: held.lotName,
            lotNo: held.lotNo,
            holderNodeName: proc.nodeName,
            holderSpecimenNo: held.specimenNo,
            holderOperator: held.operator,
            rangeText: fmtRange(held),
          });
        }
      }
    }
    return out;
  }, [equipmentLotIds, lots, procedures, planTs, planEnd]);

  const lotIssueHint = (lot: SupplyLot | undefined, qty: number): { severity: 'error' | 'warning' | 'success'; text: string } | null => {
    if (!lot) return null;
    if (isExpired(lot)) return { severity: 'error', text: `批号 ${lot.lotNo} 已过保质期，须改选批次` };
    const bal = lotBalance(lot);
    if (qty > bal) return { severity: 'error', text: `余量仅 ${bal} ${lot.unit}，不够本次领用` };
    if (bal <= lot.lowThreshold) return { severity: 'warning', text: `余量 ${bal} ${lot.unit}（低量）` };
    return { severity: 'success', text: `余量 ${bal} ${lot.unit}，可领 ${qty} ${lot.unit}` };
  };

  const adhesiveHint = lotIssueHint(chosenAdhesiveLot, adhesiveQty);
  const abrasiveHint = lotIssueHint(chosenAbrasiveLot, abrasiveQty);

  const clearForm = () => {
    setNodeName('');
    setTools([]);
    setEquipmentLotIds([]);
    setAbrasive('');
    setAbrasiveLotId('');
    setAdhesive('');
    setAdhesiveLotId('');
    setSeq(nextSeq);
    setPlanStartAt(toDatetimeLocalValue(Date.now()));
    setError('');
    setConflictAlert(null);
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  };

  const submit = async () => {
    setError('');
    setConflictAlert(null);
    if (!specimenId) {
      setError('请先选择标本');
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      return;
    }
    if (!planStartAt || !Number.isFinite(new Date(planStartAt).getTime())) {
      setError('请选择计划占用时段');
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      return;
    }
    if (!Number.isFinite(adhesiveQty) || adhesiveQty <= 0) {
      setError('胶种领用数量需大于 0');
      return;
    }

    setSubmitting(true);
    try {
      const claims = [];
      if (fieldMap.adhesives.length > 0 && adhesive && adhesiveLotId) {
        claims.push({ lotId: adhesiveLotId, qty: adhesiveQty, role: 'adhesive' as const });
      }
      if (fieldMap.abrasives.length > 0 && abrasive && abrasiveLotId && abrasiveQty > 0) {
        claims.push({ lotId: abrasiveLotId, qty: abrasiveQty, role: 'abrasive' as const });
      }

      const { procedure: record } = await createProcedureWithOccupancy({
        specimenNo: specimen?.specimenNo ?? '',
        planStartAt: planTs,
        claims,
        draft: {
          specimenId,
          stepType,
          nodeName: nodeName.trim(),
          seq,
          tools,
          abrasive: fieldMap.abrasives.length > 0 ? abrasive : '',
          adhesive: fieldMap.adhesives.length > 0 ? adhesive : '',
          adhesiveConc: fieldMap.needConc ? (Number.isFinite(adhesiveConcValue) ? adhesiveConcValue : 5) : 0,
          durationMin,
          tempC,
          rh,
          photoBeforeIds: [],
          photoAfterIds: [],
          operator: operator.trim(),
          startedAt: Date.now(),
          state: 'pending',
        },
      });

      // 工序占用账已落库；影像写库失败不冲销工序，仅提示
      if (withPhotos && specimen) {
        try {
          const before: PrepPhoto = {
            id: newId('pho'),
            specimenId,
            procedureId: record.id,
            stage: 'before',
            caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
            dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
            capturedAt: Date.now(),
          };
          const after: PrepPhoto = {
            id: newId('pho'),
            specimenId,
            procedureId: record.id,
            stage: 'after',
            caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
            dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
            capturedAt: Date.now() + 1,
          };
          await db.photos.bulkPut([before, after]);
        } catch {
          setToast('工序与占用已保存，但留痕影像写库失败，可稍后补挂');
        }
      }

      notifyOccupancyChanged({ type: 'procedure-created', at: Date.now() });
      setToast(`已保存节点 #${seq}，领用与设备占用已入账`);
      clearForm();
    } catch (e) {
      // 扣减/占用写库失败：事务已回滚，余量恢复原样；表单草稿保留，可直接改了再提交
      if (e instanceof LedgerError) {
        setError(e.message);
        if (e.code === 'equipment_conflict' && e.conflict) {
          const c = e.conflict;
          setConflictAlert({
            lotName: c.lotName,
            lotNo: c.lotNo,
            holderNodeName: c.holderNodeName,
            holderSpecimenNo: c.holderSpecimenNo,
            holderOperator: c.holderOperator,
            rangeText: fmtRange({
              lotId: c.lotId, lotName: c.lotName, lotNo: c.lotNo,
              startAt: c.startAt, endAt: c.endAt, claimedAt: c.claimedAt,
              operator: c.holderOperator, specimenNo: c.holderSpecimenNo,
            }),
          });
        }
      } else {
        setError('占用账写库失败，已全部回滚、余量未变，请用保留的草稿改后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 浓度字段（沿用原有）

  const doRollback = async (pid: string) => {
    // store.rollback 已在事务后广播占用账变更，这里不再重复通知
    await rollback(pid);
    setToast('节点已回退：领用流水作废、余量恢复，设备时段已释放');
  };

  const doReschedule = async () => {
    if (!rescheduleTarget) return;
    const ts = new Date(rescheduleValue).getTime();
    if (!Number.isFinite(ts)) {
      setError('改时段的时间格式无效');
      return;
    }
    try {
      await reschedule(rescheduleTarget, ts);
      setToast('时段已改动，设备占用与对照说明已重算');
      setRescheduleTarget(null);
      setError('');
    } catch (e) {
      if (e instanceof LedgerError) {
        setError(e.message);
        if (e.conflict) {
          const c = e.conflict;
          setConflictAlert({
            lotName: c.lotName, lotNo: c.lotNo, holderNodeName: c.holderNodeName,
            holderSpecimenNo: c.holderSpecimenNo, holderOperator: c.holderOperator,
            rangeText: fmtRange({
              lotId: c.lotId, lotName: c.lotName, lotNo: c.lotNo,
              startAt: c.startAt, endAt: c.endAt, claimedAt: c.claimedAt,
              operator: c.holderOperator, specimenNo: c.holderSpecimenNo,
            }),
          });
        }
      }
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      {resumeHint ? (
        <Alert
          severity="info"
          data-testid="draft-resume"
          action={
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" onClick={() => applyDraft(resumeHint)}>
                恢复草稿
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setResumeHint(null);
                  try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
                }}
              >
                丢弃
              </Button>
            </Stack>
          }
        >
          有一份未提交的工序草稿（{resumeHint.stepType} · {resumeHint.nodeName || '未命名'}），可恢复接着改。
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}
            {conflictAlert ? (
              <Alert
                severity="error"
                data-testid="equipment-conflict"
                action={<Button size="small" onClick={() => { setError(''); setConflictAlert(null); }}>知道了</Button>}
              >
                <Typography variant="body2" fontWeight={700}>
                  同一时段设备只留先到的占用
                </Typography>
                <Typography variant="body2">
                  设备：{conflictAlert.lotName}（批号 {conflictAlert.lotNo}）
                </Typography>
                <Typography variant="body2">
                  先到占用方：{conflictAlert.holderSpecimenNo} · 工序 #{conflictAlert.holderNodeName}
                </Typography>
                <Typography variant="body2">
                  责任人：{conflictAlert.holderOperator}
                </Typography>
                <Typography variant="body2">占用时段：{conflictAlert.rangeText}</Typography>
                <Typography variant="caption">本道工序已退回，请改时段或更换设备后重新提交，草稿已保留。</Typography>
              </Alert>
            ) : null}

            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                setSpecimenId(e.target.value);
                setSeq(1);
              }}
            >
              {specimens.map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.specimenNo} · {it.taxon}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="工序类型"
                value={stepType}
                onChange={(e) => {
                  const next = e.target.value as StepType;
                  setStepType(next);
                  setTools([]);
                  setEquipmentLotIds([]);
                  setAbrasive('');
                  setAbrasiveLotId('');
                  setAdhesive('');
                  setAdhesiveLotId('');
                }}
              >
                {STEP_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="节点名称"
                required
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
              />
              <Box sx={{ width: 120 }}>
                <MeasureField
                  label="序号"
                  unit="seq"
                  min={1}
                  max={999}
                  step={1}
                  value={seq}
                  onChange={setSeq}
                  hint={`不得跳号，建议 ${nextSeq}`}
                />
              </Box>
            </Stack>

            {fieldMap.tools.length > 0 ? (
              <TextField
                select
                size="small"
                label="使用工具 / 设备"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="选中真空浸渗罐等在库设备后，下方按设备批次登记时段占用"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {equipmentLots.length > 0 ? (
              <Paper variant="outlined" sx={{ p: 1.25, bgcolor: 'grey.50' }}>
                <Stack spacing={1}>
                  <Typography variant="subtitle2">
                    <AccessTimeIcon fontSize="inherit" sx={{ mr: 0.5, verticalAlign: 'middle' }} />
                    设备时段占用（同一设备同一时段只留先到者）
                  </Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="占用设备批次"
                      SelectProps={{ multiple: true }}
                      value={equipmentLotIds}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEquipmentLotIds(typeof v === 'string' ? v.split(',') : v);
                      }}
                    >
                      {equipmentLots.map((l) => (
                        <MenuItem key={l.id} value={l.id}>
                          {l.name} · 批号 {l.lotNo}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      size="small"
                      fullWidth
                      type="datetime-local"
                      label="计划开始时段"
                      value={planStartAt}
                      onChange={(e) => setPlanStartAt(e.target.value)}
                      InputLabelProps={{ shrink: true }}
                    />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    预计占用至 {new Date(planEnd).toLocaleString('zh-CN')}（按耗时 {durationMin} min）
                  </Typography>
                  {slotConflicts.length > 0 ? (
                    <Stack spacing={0.5} data-testid="slot-conflicts">
                      {slotConflicts.map((c, i) => (
                        <Alert key={i} severity="warning">
                          {c.lotName}（{c.lotNo}）已被占：{c.rangeText}，节点「{c.holderNodeName}」
                        </Alert>
                      ))}
                    </Stack>
                  ) : equipmentLotIds.length > 0 ? (
                    <Alert severity="success">所选时段当前无人占用，提交后先到先得。</Alert>
                  ) : null}
                </Stack>
              </Paper>
            ) : null}

            {fieldMap.abrasives.length > 0 ? (
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <TextField
                  select
                  size="small"
                    sx={{ minWidth: 140 }}
                  label="磨料目数"
                  value={abrasive}
                  onChange={(e) => {
                    setAbrasive(e.target.value);
                    setAbrasiveLotId('');
                  }}
                >
                  <MenuItem value="">不适用</MenuItem>
                  {fieldMap.abrasives.map((a) => (
                    <MenuItem key={a} value={a}>
                      {a}
                    </MenuItem>
                  ))}
                </TextField>
                {abrasive ? (
                  <>
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="磨料批次（按批号领用）"
                      value={abrasiveLotId}
                      onChange={(e) => setAbrasiveLotId(e.target.value)}
                    >
                      <MenuItem value="">请选择批次</MenuItem>
                      {abrasiveLots.map((l) => {
                        const bal = lotBalance(l);
                        const exp = isExpired(l);
                        return (
                          <MenuItem key={l.id} value={l.id} disabled={exp || bal <= 0}>
                            {l.lotNo} · 余量 {bal} {l.unit}{exp ? ' · 已过期' : ''}
                          </MenuItem>
                        );
                      })}
                    </TextField>
                    <Box sx={{ width: 150 }}>
                      <MeasureField
                        label="领用量"
                        unit={chosenAbrasiveLot?.unit ?? '件'}
                        min={1}
                        max={chosenAbrasiveLot ? lotBalance(chosenAbrasiveLot) : 1}
                        step={1}
                        value={abrasiveQty}
                        onChange={setAbrasiveQty}
                      />
                    </Box>
                  </>
                ) : null}
              </Stack>
            ) : null}
            {abrasiveHint ? (
              <Alert severity={abrasiveHint.severity}>{abrasiveHint.text}</Alert>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <TextField
                  select
                  size="small"
                  sx={{ minWidth: 160 }}
                  label="胶种"
                  value={adhesive}
                  onChange={(e) => {
                    setAdhesive(e.target.value);
                    setAdhesiveLotId('');
                  }}
                >
                  <MenuItem value="">未选定</MenuItem>
                  {fieldMap.adhesives.map((a) => (
                    <MenuItem key={a} value={a}>
                      {a}
                    </MenuItem>
                  ))}
                </TextField>
                {adhesive ? (
                  <>
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="胶种批次（按批号领用）"
                      value={adhesiveLotId}
                      onChange={(e) => setAdhesiveLotId(e.target.value)}
                    >
                      <MenuItem value="">请选择批次</MenuItem>
                      {adhesiveLots.map((l) => {
                        const bal = lotBalance(l);
                        const exp = isExpired(l);
                        return (
                          <MenuItem key={l.id} value={l.id} disabled={exp || bal <= 0}>
                            {l.lotNo} · 余量 {bal} {l.unit}{exp ? ' · 已过期' : ''}
                          </MenuItem>
                        );
                      })}
                    </TextField>
                    <Box sx={{ width: 140 }}>
                      <MeasureField
                        label="领用量"
                        unit={chosenAdhesiveLot?.unit ?? '瓶'}
                        min={1}
                        max={chosenAdhesiveLot ? lotBalance(chosenAdhesiveLot) : 1}
                        step={1}
                        value={adhesiveQty}
                        onChange={setAdhesiveQty}
                      />
                    </Box>
                  </>
                ) : null}
                {fieldMap.needConc ? (
                  <Box sx={{ width: 130 }}>
                    <MeasureField
                      label="胶液浓度"
                      unit="%"
                      min={0}
                      max={100}
                      step={0.5}
                      value={adhesiveConcValue}
                      onChange={setAdhesiveConcValue}
                    />
                  </Box>
                ) : null}
              </Stack>
            ) : null}
            {adhesiveHint ? (
              <Alert severity={adhesiveHint.severity} data-testid="adhesive-hint">
                {adhesiveHint.text}
              </Alert>
            ) : null}

            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="耗时"
                  unit="min"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={setDurationMin}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="环境温度" unit="℃" min={-10} max={60} step={0.5} value={tempC} onChange={setTempC} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="相对湿度" unit="%" min={0} max={100} step={1} value={rh} onChange={setRh} />
              </Box>
            </Stack>

            <TextField
              size="small"
              label="责任人"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />

            <FormControlLabel
              control={<Checkbox checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />}
              label="同时挂接修复前 / 修复后留痕影像（本地生成）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit} disabled={submitting} data-testid="procedure-submit">
                {submitting ? '占用入账中…' : '保存节点（校验余量/保质期/设备时段）'}
              </Button>
              <Button onClick={clearForm}>清空重填</Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            该标本现有工序
          </Typography>
          {specimen ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {specimen.specimenNo} · 完成度 {progress.percent}% · 待办{' '}
              {progress.current ? `#${progress.current.seq} ${progress.current.nodeName}` : '无'}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (pid) => {
              await addProcedureDone(pid);
              setToast('节点已完成');
            }}
            onRollback={doRollback}
            onReschedule={(pid, ts) => {
              setRescheduleTarget(pid);
              setRescheduleValue(toDatetimeLocalValue(ts));
            }}
          />
          {rescheduleTarget ? (
            <Paper variant="outlined" sx={{ p: 1.5, mt: 1.5 }}>
              <Stack spacing={1}>
                <Typography variant="subtitle2">改动计划时段（占用立即重算）</Typography>
                <TextField
                  size="small"
                  type="datetime-local"
                  label="新的开始时段"
                  value={rescheduleValue}
                  onChange={(e) => setRescheduleValue(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" onClick={doReschedule}>
                    确认改时段
                  </Button>
                  <Button size="small" onClick={() => setRescheduleTarget(null)}>
                    取消
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          ) : null}
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

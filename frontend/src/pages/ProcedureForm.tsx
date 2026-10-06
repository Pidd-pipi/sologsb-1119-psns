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
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { useOccupationStore } from '../stores/occupationStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import {
  STEP_FIELD_MAP,
  STEP_TYPES,
  isSharedEquipment,
  type StepType,
} from '../types/procedure';
import { isExpired, remainingQty, shelfLifeLeftDays } from '../types/supply';
import { findAllConflicts, fmtDateTime, fromLocalInput, toLocalInput } from '../types/occupation';
import { LedgerReject } from '../utils/ledger';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

const DRAFT_KEY = 'gbfossilprep:procedure-draft';

/** 未提交成功的草稿留着：刷新/写库失败后还能接着改 */
interface SavedDraft {
  specimenId?: string;
  stepType: StepType;
  nodeName: string;
  seq: number;
  tools: string[];
  abrasive: string;
  adhesive: string;
  adhesiveConc: number;
  adhesiveLotId: string;
  adhesiveIssueQty: number;
  planStartInput: string;
  durationMin: number;
  tempC: number;
  rh: number;
  operator: string;
  withPhotos: boolean;
}

function defaultPlanStart(): string {
  const t = new Date(Date.now() + 3600 * 1000);
  t.setMinutes(t.getMinutes() < 30 ? 30 : 0, 0, 0);
  return toLocalInput(t.getTime());
}

function loadDraft(): Partial<SavedDraft> | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as SavedDraft) : null;
  } catch {
    return null;
  }
}

/** /procedures/new 新建工序节点：序号连续校验 + 统一占用账（材料余量、设备时段） */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.submit);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const lots = useSupplyStore((s) => s.items);
  const loadSupplies = useSupplyStore((s) => s.load);
  const occupations = useOccupationStore((s) => s.items);
  const loadOccupations = useOccupationStore((s) => s.load);

  const saved = useMemo(() => loadDraft(), []);

  const [specimenId, setSpecimenId] = useState(
    saved?.specimenId ?? params.get('specimenId') ?? specimens[0]?.id ?? '',
  );
  const [stepType, setStepType] = useState<StepType>(saved?.stepType ?? '清修');
  const [nodeName, setNodeName] = useState(saved?.nodeName ?? '');
  const [seq, setSeq] = useState(saved?.seq ?? 1);
  const [tools, setTools] = useState<string[]>(saved?.tools ?? []);
  const [abrasive, setAbrasive] = useState(saved?.abrasive ?? '');
  const [adhesive, setAdhesive] = useState(saved?.adhesive ?? '');
  const [adhesiveConc, setAdhesiveConc] = useState(saved?.adhesiveConc ?? 5);
  const [adhesiveLotId, setAdhesiveLotId] = useState(saved?.adhesiveLotId ?? '');
  const [adhesiveIssueQty, setAdhesiveIssueQty] = useState(saved?.adhesiveIssueQty ?? 1);
  const [planStartInput, setPlanStartInput] = useState(saved?.planStartInput ?? defaultPlanStart());
  const [durationMin, setDurationMin] = useState(saved?.durationMin ?? 60);
  const [tempC, setTempC] = useState(saved?.tempC ?? 22);
  const [rh, setRh] = useState(saved?.rh ?? 50);
  const [operator, setOperator] = useState(saved?.operator ?? '');
  const [withPhotos, setWithPhotos] = useState(saved?.withPhotos ?? true);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [error, setError] = useState('');
  /** 设备争用被退回时，当场展示占用方与责任人 */
  const [holder, setHolder] = useState<ReturnType<typeof findAllConflicts>>([]);
  const [toast, setToast] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  // 任意改动即时落草稿（写库失败/关页面后都能接着改）
  useEffect(() => {
    const draft: SavedDraft = {
      specimenId,
      stepType,
      nodeName,
      seq,
      tools,
      abrasive,
      adhesive,
      adhesiveConc,
      adhesiveLotId,
      adhesiveIssueQty,
      planStartInput,
      durationMin,
      tempC,
      rh,
      operator,
      withPhotos,
    };
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, [
    specimenId,
    stepType,
    nodeName,
    seq,
    tools,
    abrasive,
    adhesive,
    adhesiveConc,
    adhesiveLotId,
    adhesiveIssueQty,
    planStartInput,
    durationMin,
    tempC,
    rh,
    operator,
    withPhotos,
  ]);

  const planStart = fromLocalInput(planStartInput);
  const planEnd = Number.isFinite(planStart) ? planStart + durationMin * 60000 : NaN;

  // 同名胶种候选批次：余量按这批已有领用记录实时重算
  const adhesiveLots = useMemo(
    () => lots.filter((lot) => lot.kind === '胶种' && (!adhesive || lot.name === adhesive)),
    [lots, adhesive],
  );
  const selectedLot = lots.find((lot) => lot.id === adhesiveLotId);
  const selectedRemaining = selectedLot ? remainingQty(selectedLot) : 0;
  const selectedExpired = selectedLot ? isExpired(selectedLot) : false;

  // 设备争用预演：选中真空浸渗罐等独占设备时，当场显示先到占用方
  const liveConflicts = useMemo(() => {
    if (!Number.isFinite(planStart)) return [];
    const shared = tools.filter(isSharedEquipment);
    if (shared.length === 0) return [];
    return findAllConflicts(occupations, shared[0], planStart, planEnd);
  }, [occupations, tools, planStart, planEnd]);

  const clearDraft = () => {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  };

  const submit = async () => {
    setError('');
    setHolder([]);
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
    if (!Number.isFinite(planStart)) {
      setError('请选择有效的计划占用时段');
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
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      return;
    }
    const useAdhesive = fieldMap.adhesives.length > 0 && !!adhesive;
    if (useAdhesive && !adhesiveLotId) {
      setError('已选胶种，请选择领用批次（同一份占用账按批次扣余量）');
      return;
    }
    if (useAdhesive && (!(adhesiveIssueQty > 0))) {
      setError('领用数量需大于 0');
      return;
    }

    setSubmitting(true);
    try {
      const record = await addProcedure(
        {
          specimenId,
          stepType,
          nodeName: nodeName.trim(),
          seq,
          tools,
          abrasive,
          adhesive: useAdhesive ? adhesive : '',
          adhesiveConc: fieldMap.needConc ? adhesiveConc : 0,
          adhesiveLotId: useAdhesive ? adhesiveLotId : undefined,
          adhesiveIssueQty: useAdhesive ? adhesiveIssueQty : undefined,
          durationMin,
          planStart,
          tempC,
          rh,
          photoBeforeIds: [],
          photoAfterIds: [],
          operator: operator.trim(),
          startedAt: Date.now(),
          state: 'pending',
        },
        simulateFailure,
      );

      if (withPhotos && specimen) {
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
      }

      // 提交成功：占用账两侧刷新，余量与占用方立即重算
      await Promise.all([loadSupplies(), loadOccupations()]);
      clearDraft();
      setToast(`已追加工序节点 #${seq} ${stepType} · ${record.nodeName}`);
      setNodeName('');
      setTools([]);
      setSeq(nextSeq + 1);
      setAdhesiveLotId('');
      setAdhesiveIssueQty(1);
      setSimulateFailure(false);
    } catch (e) {
      // 被占用账退回：不够 / 过期 / 设备争用输给先到者，草稿保留继续改
      if (e instanceof LedgerReject) {
        setError(e.message);
        if (e.code === 'EQUIPMENT_CONFLICT' && e.conflicts) {
          setHolder(e.conflicts);
        }
      } else {
        // 扣减写库失败：事务已回滚，余量恢复原样；重新装载核对
        await Promise.all([loadSupplies(), loadOccupations()]);
        setError(e instanceof Error ? `写库失败，已整体回滚（余量未扣、占用未登记）：${e.message}` : '写库失败，已整体回滚');
      }
    } finally {
      setSubmitting(false);
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
        <Chip size="small" color="info" variant="outlined" label="占用账：材料余量 + 设备时段同一份" />
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}

            {holder.length > 0 ? (
              <Alert severity="warning" data-testid="equipment-holder">
                <Typography variant="body2" fontWeight={700}>
                  同一设备同一时段只留先到的占用，本道工序被退回，请改时段后重提：
                </Typography>
                {holder.map((h) => (
                  <Typography key={h.id} variant="body2" sx={{ mt: 0.5 }}>
                    占用方：{h.specimenNo} · #{h.seq} {h.stepType}（{h.nodeName}）；责任人：
                    <b>{h.operator}</b>；已占时段 {fmtDateTime(h.startAt)} ~ {fmtDateTime(h.endAt)}
                  </Typography>
                ))}
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
                  setAbrasive('');
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
                label="使用工具（含独占设备）"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="真空浸渗罐等独占设备按「同一设备同一时段先到先得」争用"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                    {isSharedEquipment(t) ? '（独占设备）' : ''}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {tools.some(isSharedEquipment) ? (
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                <TextField
                  size="small"
                  fullWidth
                  type="datetime-local"
                  label="计划开始占用时段"
                  value={planStartInput}
                  onChange={(e) => setPlanStartInput(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
                <Box sx={{ flex: 1 }}>
                  <MeasureField
                    label="占用时长"
                    unit="min"
                    min={1}
                    max={1440}
                    step={5}
                    value={durationMin}
                    onChange={setDurationMin}
                    hint={`占用至 ${Number.isFinite(planEnd) ? fmtDateTime(planEnd) : '—'}`}
                  />
                </Box>
              </Stack>
            ) : (
              <Box>
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
            )}

            {liveConflicts.length > 0 && tools.some(isSharedEquipment) ? (
              <Alert severity="warning" data-testid="live-conflict">
                该时段设备已被先到方占用：
                {liveConflicts.map((h) => (
                  <Typography key={h.id} variant="body2">
                    {h.specimenNo} · #{h.seq} {h.nodeName}，责任人 <b>{h.operator}</b>（{fmtDateTime(h.startAt)} ~{' '}
                    {fmtDateTime(h.endAt)}）
                  </Typography>
                ))}
              </Alert>
            ) : null}

            {fieldMap.abrasives.length > 0 ? (
              <TextField
                select
                size="small"
                label="磨料目数"
                value={abrasive}
                onChange={(e) => setAbrasive(e.target.value)}
              >
                <MenuItem value="">不适用</MenuItem>
                {fieldMap.abrasives.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1.5}>
                  <TextField
                    select
                    size="small"
                    fullWidth
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
                  {fieldMap.needConc ? (
                    <Box sx={{ flex: 1 }}>
                      <MeasureField
                        label="胶液浓度"
                        unit="%"
                        min={0}
                        max={100}
                        step={0.5}
                        value={adhesiveConc}
                        onChange={setAdhesiveConc}
                      />
                    </Box>
                  ) : null}
                </Stack>
                {adhesive ? (
                  <Stack direction="row" spacing={1.5} alignItems="flex-start">
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="领用批次（余量按该批领用记录实时重算）"
                      value={adhesiveLotId}
                      onChange={(e) => setAdhesiveLotId(e.target.value)}
                    >
                      {adhesiveLots.length === 0 ? (
                        <MenuItem value="">该胶种暂无在库批次，请先到材料台账登记</MenuItem>
                      ) : null}
                      {adhesiveLots.map((lot) => {
                        const left = shelfLifeLeftDays(lot);
                        return (
                          <MenuItem key={lot.id} value={lot.id}>
                            批号 {lot.lotNo} · 余量 {remainingQty(lot)} {lot.unit} ·{' '}
                            {left < 0 ? `已过期 ${-left} 天` : `剩余保质 ${left} 天`}
                          </MenuItem>
                        );
                      })}
                    </TextField>
                    <Box sx={{ width: 180 }}>
                      <MeasureField
                        label="领用数量"
                        unit={selectedLot?.unit ?? '件'}
                        min={1}
                        max={Math.max(1, selectedRemaining)}
                        step={1}
                        value={adhesiveIssueQty}
                        onChange={setAdhesiveIssueQty}
                        hint={
                          selectedLot
                            ? selectedExpired
                              ? '该批次已过保质期，退回改选'
                              : `现存余量 ${selectedRemaining} ${selectedLot.unit}`
                            : undefined
                        }
                      />
                    </Box>
                  </Stack>
                ) : null}
                {selectedLot && selectedExpired ? (
                  <Alert severity="error" data-testid="lot-expired">
                    批号 {selectedLot.lotNo} 已过保质期 {-shelfLifeLeftDays(selectedLot)} 天，不能领用，请退回本道工序改选批次。
                  </Alert>
                ) : null}
                {selectedLot && !selectedExpired && adhesiveIssueQty > selectedRemaining ? (
                  <Alert severity="error" data-testid="lot-insufficient">
                    批号 {selectedLot.lotNo} 余量仅 {selectedRemaining} {selectedLot.unit}，不够本次领用，请减量或改批次。
                  </Alert>
                ) : null}
              </Stack>
            ) : null}

            {!tools.some(isSharedEquipment) ? null : (
              <Typography variant="caption" color="text.secondary">
                提示：独占设备的耗时即设备占用时长，起止 = 计划时段 + 占用时长。
              </Typography>
            )}

            <Stack direction="row" spacing={1.5}>
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
            <FormControlLabel
              control={<Checkbox checked={simulateFailure} onChange={(e) => setSimulateFailure(e.target.checked)} />}
              label="演练：制造一次扣减写库失败（验证余量恢复、草稿保留）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit} disabled={submitting}>
                {submitting ? '提交占用账中…' : '保存节点'}
              </Button>
              <Button
                onClick={() => {
                  clearDraft();
                  navigate('/procedures/new');
                }}
              >
                清空重填
              </Button>
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
              await finish(pid);
              setToast('节点已完成');
            }}
            onRollback={async (pid) => {
              await rollback(pid);
              await Promise.all([loadSupplies(), loadOccupations()]);
              setToast('节点已回退：设备占用与领用已作废，余量已重算');
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

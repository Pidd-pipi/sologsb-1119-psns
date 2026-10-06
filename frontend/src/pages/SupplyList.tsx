import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import AddIcon from '@mui/icons-material/Add';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { useSupplyStore } from '../stores/supplyStore';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { MeasureField } from '../components/common/MeasureField';
import {
  SUPPLY_KINDS,
  isExpired,
  isLowStock,
  lotBalance,
  shelfLifeLeftDays,
  type SupplyKind,
  type SupplyLot,
  type SupplyLotDraft,
} from '../types/supply';
import type { EquipmentBooking } from '../types/procedure';
import { LedgerError } from '../utils/ledger';

const EMPTY_DRAFT: SupplyLotDraft = {
  name: '',
  kind: '胶种',
  spec: '',
  lotNo: '',
  stockQty: 1,
  unit: '瓶',
  openedAt: Date.now(),
  shelfLifeMonths: 24,
  lowThreshold: 2,
};

function fmtRange(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** /supplies 工具材料台账：按种类分组、批号追溯、低量/过期高亮、设备时段占用看板 */
export default function SupplyList() {
  const lots = useSupplyStore((s) => s.items);
  const addLot = useSupplyStore((s) => s.add);
  const issue = useSupplyStore((s) => s.issue);
  const specimens = useSpecimenStore((s) => s.items);
  const procedures = useProcedureStore((s) => s.items);

  const [trace, setTrace] = useState('');
  const [kindFilter, setKindFilter] = useState<SupplyKind | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<SupplyLotDraft>(EMPTY_DRAFT);
  const [issueTarget, setIssueTarget] = useState<SupplyLot | null>(null);
  const [issueQty, setIssueQty] = useState(1);
  const [issueOperator, setIssueOperator] = useState('');
  const [issueSpecimen, setIssueSpecimen] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const filtered = useMemo(() => {
    const kw = trace.trim();
    return lots.filter((lot) => {
      if (kindFilter !== 'all' && lot.kind !== kindFilter) return false;
      if (kw && !lot.lotNo.includes(kw) && !lot.name.includes(kw) && !lot.spec.includes(kw)) return false;
      return true;
    });
  }, [lots, trace, kindFilter]);

  const grouped = useMemo(() => {
    return SUPPLY_KINDS.map((kind) => ({ kind, rows: filtered.filter((lot) => lot.kind === kind) })).filter(
      (g) => kindFilter === 'all' || g.kind === kindFilter,
    );
  }, [filtered, kindFilter]);

  // 设备（工具类批次）的在效时段占用，统一从工序占用账汇总
  const equipmentBoard = useMemo(() => {
    const rows: { lot: SupplyLot; booking: EquipmentBooking; nodeName: string; state: string }[] = [];
    for (const lot of lots.filter((l) => l.kind === '工具')) {
      for (const proc of procedures) {
        if (proc.state === 'rolledback') continue;
        for (const b of proc.bookings ?? []) {
          if (b.lotId === lot.id) {
            rows.push({ lot, booking: b, nodeName: proc.nodeName, state: proc.state });
          }
        }
      }
    }
    rows.sort((a, b) => a.booking.startAt - b.booking.startAt);
    return rows;
  }, [lots, procedures]);

  const submitLot = async () => {
    if (!draft.name.trim() || !draft.lotNo.trim()) {
      setError('名称与批号必填');
      return;
    }
    if (!(draft.stockQty >= 0)) {
      setError('入库数量需 ≥ 0');
      return;
    }
    await addLot({ ...draft, name: draft.name.trim(), lotNo: draft.lotNo.trim() });
    setCreateOpen(false);
    setDraft(EMPTY_DRAFT);
    setError('');
    setToast('已登记材料批次（入库量即初始余量）');
  };

  const submitIssue = async () => {
    if (!issueTarget) return;
    const targetSpecimen = specimens.find((s) => s.specimenNo === issueSpecimen);
    try {
      await issue(issueTarget.id, {
        qty: issueQty,
        operator: issueOperator.trim(),
        specimenNo: issueSpecimen || '未关联标本',
        specimenId: targetSpecimen?.id,
      });
      setIssueTarget(null);
      setIssueQty(1);
      setIssueOperator('');
      setIssueSpecimen('');
      setError('');
      setToast('领用已按批次流水登记，余量已重算');
    } catch (e) {
      // 过期 / 余量不足：占用账事务已回滚，余量原样不变；领用对话框与输入保留
      setError(e instanceof LedgerError ? e.message : '领用写库失败，余量未变，请重试');
    }
  };

  const lowCount = lots.filter(isLowStock).length;
  const expiredCount = lots.filter((l) => isExpired(l)).length;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          工具材料台账
        </Typography>
        <Chip size="small" label={`共 ${lots.length} 个批次`} />
        <Chip size="small" color={lowCount > 0 ? 'warning' : 'default'} label={`低量 ${lowCount} 项`} />
        <Chip size="small" color={expiredCount > 0 ? 'error' : 'default'} label={`过期 ${expiredCount} 项`} />
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          登记批次
        </Button>
      </Stack>

      {equipmentBoard.length > 0 ? (
        <Paper variant="outlined" sx={{ p: 2 }} data-testid="equipment-board">
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <ScheduleIcon fontSize="small" />
            <Typography variant="subtitle1" fontWeight={700}>
              设备时段占用账
            </Typography>
            <Chip size="small" label={`${equipmentBoard.length} 条占用`} />
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>设备</TableCell>
                <TableCell>批号</TableCell>
                <TableCell>占用时段</TableCell>
                <TableCell>占用工序</TableCell>
                <TableCell>占用方（标本）</TableCell>
                <TableCell>责任人</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {equipmentBoard.map(({ lot, booking, nodeName, state }, i) => (
                <TableRow key={`${booking.lotId}-${booking.startAt}-${i}`} hover>
                  <TableCell>{lot.name}</TableCell>
                  <TableCell>{booking.lotNo}</TableCell>
                  <TableCell>
                    {fmtRange(booking.startAt)} ~ {fmtRange(booking.endAt)}
                  </TableCell>
                  <TableCell>
                    {nodeName}
                    <Chip
                      size="small"
                      sx={{ ml: 0.5 }}
                      label={state === 'done' ? '已完成' : '待办'}
                      color={state === 'done' ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>{booking.specimenNo}</TableCell>
                  <TableCell>{booking.operator}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary">
            同一设备同一时段两份占用同时提交时只留先到者；工序回退或改时段后此表立即重算。
          </Typography>
        </Paper>
      ) : null}

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} useFlexGap>
          <TextField
            size="small"
            label="批号 / 名称追溯"
            value={trace}
            onChange={(e) => setTrace(e.target.value)}
            sx={{ minWidth: 240 }}
            helperText="输入批号片段可定位该批次的全部领用记录（含已作废）"
          />
          <TextField
            select
            size="small"
            label="种类"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as SupplyKind | 'all')}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="all">全部</MenuItem>
            {SUPPLY_KINDS.map((k) => (
              <MenuItem key={k} value={k}>
                {k}
              </MenuItem>
            ))}
          </TextField>
          <Button onClick={() => { setTrace(''); setKindFilter('all'); }}>重置</Button>
        </Stack>
      </Paper>

      {grouped.map((group) => (
        <Paper key={group.kind} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              {group.kind}
            </Typography>
            <Chip size="small" label={`${group.rows.length} 个批次`} />
          </Stack>
          {group.rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              该种类下暂无批次。
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>名称</TableCell>
                  <TableCell>规格</TableCell>
                  <TableCell>批号</TableCell>
                  <TableCell align="right">入库</TableCell>
                  <TableCell align="right">余量（重算）</TableCell>
                  <TableCell align="right">低量阈值</TableCell>
                  <TableCell align="right">剩余保质期</TableCell>
                  <TableCell>最近领用</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {group.rows.map((lot) => {
                  const low = isLowStock(lot);
                  const expired = isExpired(lot);
                  const left = shelfLifeLeftDays(lot);
                  const balance = lotBalance(lot);
                  return (
                    <TableRow
                      key={lot.id}
                      hover
                      data-testid={`supply-row-${lot.lotNo}`}
                      sx={expired ? { bgcolor: 'error.light' } : low ? { bgcolor: 'warning.light' } : undefined}
                    >
                      <TableCell>
                        {lot.name}
                        {expired ? <Chip size="small" color="error" label="已过期" sx={{ ml: 1 }} /> : null}
                        {low ? <Chip size="small" color="warning" label="低量" sx={{ ml: expired ? 0.5 : 1 }} /> : null}
                      </TableCell>
                      <TableCell>{lot.spec}</TableCell>
                      <TableCell>{lot.lotNo}</TableCell>
                      <TableCell align="right">
                        {lot.stockQty ?? lot.qty} {lot.unit}
                      </TableCell>
                      <TableCell align="right" data-testid={`balance-${lot.lotNo}`}>
                        <strong>{balance}</strong> {lot.unit}
                      </TableCell>
                      <TableCell align="right">{lot.lowThreshold}</TableCell>
                      <TableCell align="right">
                        {left < 0 ? <Chip size="small" color="error" label={`已过期 ${-left} 天`} /> : `${left} 天`}
                      </TableCell>
                      <TableCell>
                        {lot.issues.filter((i) => i.status !== 'voided').length === 0
                          ? '—'
                          : (() => {
                              const first = lot.issues.find((i) => i.status !== 'voided')!;
                              return `${first.operator} 领 ${first.qty} ${lot.unit}（${first.specimenNo}）${first.backfilled ? ' · 按耗时回填' : ''}`;
                            })()}
                      </TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          disabled={balance <= 0 || expired}
                          onClick={() => {
                            setIssueTarget(lot);
                            setIssueQty(1);
                            setIssueOperator('');
                            setIssueSpecimen('');
                            setError('');
                          }}
                        >
                          领用
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {group.rows.some((r) => r.issues.length > 0) ? (
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {group.rows
                .filter((r) => r.issues.length > 0)
                .map((r) => (
                  <Typography key={r.id} variant="caption" color="text.secondary" data-testid={`issues-${r.lotNo}`}>
                    批号 {r.lotNo} 的领用明细：
                    {r.issues
                      .map((i) =>
                        i.status === 'voided'
                          ? `${i.operator} ${i.qty}${r.unit}→${i.specimenNo}〔已作废${i.voidReason ? `·${i.voidReason}` : ''}〕`
                          : `${i.operator} ${i.qty}${r.unit}→${i.specimenNo}${i.backfilled ? '〔回填〕' : ''}`,
                      )
                      .join('；')}
                    ；重算余量 {lotBalance(r)} {r.unit}
                  </Typography>
                ))}
            </Stack>
          ) : null}
        </Paper>
      ))}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>登记材料批次</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TextField
              size="small"
              label="名称"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="种类"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as SupplyKind })}
              >
                {SUPPLY_KINDS.map((k) => (
                  <MenuItem key={k} value={k}>
                    {k}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="规格"
                value={draft.spec}
                onChange={(e) => setDraft({ ...draft, spec: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                fullWidth
                label="批号"
                required
                value={draft.lotNo}
                onChange={(e) => setDraft({ ...draft, lotNo: e.target.value })}
              />
              <TextField
                size="small"
                fullWidth
                label="单位"
                value={draft.unit}
                onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="入库数量"
                  unit={draft.unit}
                  min={0}
                  max={100000}
                  step={1}
                  value={draft.stockQty}
                  onChange={(v) => setDraft({ ...draft, stockQty: v })}
                  hint="入库量入账，余量 = 入库量 − 有效领用"
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="低量阈值"
                  unit={draft.unit}
                  min={0}
                  max={1000}
                  step={1}
                  value={draft.lowThreshold}
                  onChange={(v) => setDraft({ ...draft, lowThreshold: v })}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="保质期"
                  unit="月"
                  min={1}
                  max={240}
                  step={1}
                  value={draft.shelfLifeMonths}
                  onChange={(v) => setDraft({ ...draft, shelfLifeMonths: v })}
                />
              </Box>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submitLot}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!issueTarget} onClose={() => setIssueTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          领用登记{issueTarget ? ` · ${issueTarget.name}` : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error" data-testid="issue-error">{error}</Alert> : null}
            {issueTarget ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  批号 {issueTarget.lotNo} · 按领用流水重算余量{' '}
                  <strong>{lotBalance(issueTarget)}</strong> {issueTarget.unit}
                </Typography>
                {isExpired(issueTarget) ? (
                  <Alert severity="error">该批次已过保质期，禁止领用，请改选批次。</Alert>
                ) : null}
              </>
            ) : null}
            <MeasureField
              label="领用数量"
              unit={issueTarget?.unit ?? '件'}
              min={1}
              max={issueTarget ? lotBalance(issueTarget) : 1}
              step={1}
              value={issueQty}
              onChange={setIssueQty}
            />
            <TextField
              size="small"
              label="领用人"
              required
              value={issueOperator}
              onChange={(e) => setIssueOperator(e.target.value)}
            />
            <TextField
              select
              size="small"
              label="用于标本"
              value={issueSpecimen}
              onChange={(e) => setIssueSpecimen(e.target.value)}
            >
              <MenuItem value="">未关联标本</MenuItem>
              {specimens.map((s) => (
                <MenuItem key={s.id} value={s.specimenNo}>
                  {s.specimenNo}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIssueTarget(null)}>取消</Button>
          <Button variant="contained" onClick={submitIssue} disabled={!!issueTarget && isExpired(issueTarget)}>
            确认领用
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

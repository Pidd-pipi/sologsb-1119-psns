import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { useOccupationStore } from '../stores/occupationStore';
import { useProcedureStore } from '../stores/procedureStore';
import { SHARED_EQUIPMENT } from '../types/procedure';
import { fmtDateTime, toLocalInput, fromLocalInput, type EquipmentOccupation } from '../types/occupation';

/** /occupations 统一占用账（设备时段）：同一设备同一时段只留先到者 */
export default function OccupancyBoard() {
  const items = useOccupationStore((s) => s.items);
  const reschedule = useProcedureStore((s) => s.reschedule);
  const loadOccupations = useOccupationStore((s) => s.load);

  const [equipment, setEquipment] = useState<string>('all');
  const [status, setStatus] = useState<'all' | 'active' | 'voided'>('active');
  const [target, setTarget] = useState<EquipmentOccupation | null>(null);
  const [newSlot, setNewSlot] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [toast, setToast] = useState('');

  const equipments = useMemo(
    () => Array.from(new Set([...SHARED_EQUIPMENT, ...items.map((it) => it.equipment)])),
    [items],
  );

  const rows = useMemo(
    () =>
      items
        .filter((it) => (equipment === 'all' ? true : it.equipment === equipment))
        .filter((it) => (status === 'all' ? true : it.status === status))
        .sort((a, b) => a.startAt - b.startAt || a.claimedAt - b.claimedAt),
    [items, equipment, status],
  );

  const activeCount = items.filter((it) => it.status === 'active').length;

  const openReschedule = (occ: EquipmentOccupation) => {
    setTarget(occ);
    setNewSlot(toLocalInput(occ.startAt));
    setDialogError('');
  };

  const confirm = async () => {
    if (!target) return;
    const ts = fromLocalInput(newSlot);
    if (!Number.isFinite(ts)) {
      setDialogError('请选择有效的新时段');
      return;
    }
    try {
      await reschedule(target.procedureId, ts);
      await loadOccupations();
      setTarget(null);
      setToast('时段已改动：旧占用作废，余量与对照说明已按新占用重算');
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : '改期失败，原占用不变');
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          设备占用台账
        </Typography>
        <Chip size="small" label={`占用中 ${activeCount} 条`} color="info" />
        <Chip size="small" variant="outlined" label="同一设备同一时段只留先到者" />
        <Box sx={{ flex: 1 }} />
        <Button component={RouterLink} to="/procedures/new" startIcon={<ScheduleIcon />}>
          去登记工序
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} useFlexGap>
          <TextField
            select
            size="small"
            label="设备"
            value={equipment}
            onChange={(e) => setEquipment(e.target.value)}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="all">全部设备</MenuItem>
            {equipments.map((eq) => (
              <MenuItem key={eq} value={eq}>
                {eq}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="状态"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="active">占用中</MenuItem>
            <MenuItem value="voided">已作废</MenuItem>
            <MenuItem value="all">全部</MenuItem>
          </TextField>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        {rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            当前筛选下没有占用记录。
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>设备</TableCell>
                <TableCell>占用时段</TableCell>
                <TableCell>占用方（标本 / 工序）</TableCell>
                <TableCell>责任人</TableCell>
                <TableCell>提交时间</TableCell>
                <TableCell>状态</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((occ) => (
                <TableRow key={occ.id} hover data-testid={`occ-row-${occ.id}`} sx={occ.status === 'voided' ? { opacity: 0.55 } : undefined}>
                  <TableCell>
                    {occ.equipment}
                    {occ.backfilled ? <Chip size="small" variant="outlined" label="回填" sx={{ ml: 1 }} /> : null}
                  </TableCell>
                  <TableCell>
                    {fmtDateTime(occ.startAt)}
                    <br />~ {fmtDateTime(occ.endAt)}
                  </TableCell>
                  <TableCell>
                    <Button component={RouterLink} to={`/specimens/${occ.specimenId}`} size="small" sx={{ textTransform: 'none' }}>
                      {occ.specimenNo}
                    </Button>
                    {' · '}#{occ.seq} {occ.stepType}（{occ.nodeName}）
                  </TableCell>
                  <TableCell>
                    <b>{occ.operator}</b>
                  </TableCell>
                  <TableCell>{fmtDateTime(occ.claimedAt)}</TableCell>
                  <TableCell>
                    {occ.status === 'active' ? (
                      <Chip size="small" color="info" label="占用中" />
                    ) : (
                      <Chip size="small" color="default" label={`已作废${occ.replacedBy ? '（已改期）' : '（工序回退）'}`} />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {occ.status === 'active' ? (
                      <Button size="small" onClick={() => openReschedule(occ)}>
                        改期
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          工序回退或时段改动后，本表旧记录立即作废并按新时段重新争用；相关材料余量与前后对照说明同步失效重算。
        </Typography>
      </Paper>

      <Dialog open={!!target} onClose={() => setTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>占用改期{target ? ` · ${target.equipment}` : ''}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {target
                ? `当前占用：${target.specimenNo} · #${target.seq} ${target.nodeName}，责任人 ${target.operator}`
                : ''}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              改期后旧时段立即作废，按新时段重新先到先得；若已被他人先占，本次改期不生效。
            </Typography>
            {dialogError ? <Alert severity="error">{dialogError}</Alert> : null}
            <TextField
              size="small"
              fullWidth
              type="datetime-local"
              label="新开始时段"
              value={newSlot}
              onChange={(e) => setNewSlot(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTarget(null)}>取消</Button>
          <Button variant="contained" onClick={confirm}>
            确认改期并重争用
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2800} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

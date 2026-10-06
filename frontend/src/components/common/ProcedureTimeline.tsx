import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import UndoIcon from '@mui/icons-material/Undo';
import ScheduleIcon from '@mui/icons-material/Schedule';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { PrepProcedure } from '../../types/procedure';
import { isSharedEquipment } from '../../types/procedure';
import { toLocalInput, fromLocalInput, fmtDateTime } from '../../types/occupation';

export interface ProcedureTimelineProps {
  items: PrepProcedure[];
  onFinish?: (id: string) => void;
  onRollback?: (id: string) => void;
  /** 时段改动：旧占用立即作废、新时段重新争用 */
  onReschedule?: (id: string, newStartAt: number) => void | Promise<void>;
  onOpenPhoto?: (procedureId: string) => void;
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  return fmtDateTime(ts);
}

/**
 * 纵向工序节点流：步骤图标、状态、耗时、环境参数折叠区。
 * 被标本详情页、工序录入页消费。
 */
export function ProcedureTimeline({ items, onFinish, onRollback, onReschedule, onOpenPhoto }: ProcedureTimelineProps) {
  const [expanded, setExpanded] = useState<string | null>(items[0]?.id ?? null);
  const [rescheduling, setRescheduling] = useState<PrepProcedure | null>(null);
  const [newSlot, setNewSlot] = useState('');
  const [rescheduleError, setRescheduleError] = useState('');

  if (items.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          该标本暂无工序节点，请到「新建工序节点」登记。
        </Typography>
      </Paper>
    );
  }

  const openReschedule = (node: PrepProcedure) => {
    setRescheduling(node);
    setNewSlot(toLocalInput(node.planStart ?? node.startedAt));
    setRescheduleError('');
  };

  const confirmReschedule = async () => {
    if (!rescheduling || !onReschedule) return;
    const ts = fromLocalInput(newSlot);
    if (!Number.isFinite(ts)) {
      setRescheduleError('请选择有效的新时段');
      return;
    }
    try {
      await onReschedule(rescheduling.id, ts);
      setRescheduling(null);
    } catch (e) {
      setRescheduleError(e instanceof Error ? e.message : '改期失败');
    }
  };

  return (
    <Stack spacing={1} data-testid="procedure-timeline">
      {items.map((node, index) => {
        const isDone = node.state === 'done';
        const isRolledback = node.state === 'rolledback';
        const open = expanded === node.id;
        const occupies = node.tools.filter(isSharedEquipment);
        const slotEnd = (node.planStart ?? node.startedAt) + node.durationMin * 60000;
        return (
          <Box key={node.id} sx={{ display: 'flex', gap: 1.5 }}>
            <Stack alignItems="center" sx={{ pt: 0.5 }}>
              {isDone ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <RadioButtonUncheckedIcon color={isRolledback ? 'error' : 'disabled'} fontSize="small" />
              )}
              {index < items.length - 1 ? (
                <Box sx={{ flex: 1, width: '2px', minHeight: 32, bgcolor: 'divider', my: 0.5 }} />
              ) : null}
            </Stack>
            <Paper variant="outlined" sx={{ p: 1.5, flex: 1, mb: 0.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={`#${node.seq}`} color="primary" variant="outlined" />
                <Typography variant="subtitle2" fontWeight={700}>
                  {node.stepType} · {node.nodeName}
                </Typography>
                <Chip
                  size="small"
                  label={isDone ? '已完成' : isRolledback ? '已回退' : '待办'}
                  color={isDone ? 'success' : isRolledback ? 'error' : 'default'}
                />
                {occupies.length > 0 && !isRolledback ? (
                  <Tooltip title={`设备占用时段：${fmtDateTime(node.planStart ?? node.startedAt)} ~ ${fmtDateTime(slotEnd)}`}>
                    <Chip size="small" color="info" icon={<ScheduleIcon />} label={`${occupies[0]} 占用中`} />
                  </Tooltip>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  耗时 {node.durationMin} min · 责任人 {node.operator}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {!isDone && onFinish ? (
                  <Button size="small" variant="contained" onClick={() => onFinish(node.id)}>
                    完成节点
                  </Button>
                ) : null}
                {occupies.length > 0 && !isRolledback && onReschedule ? (
                  <Button size="small" color="info" startIcon={<ScheduleIcon />} onClick={() => openReschedule(node)}>
                    改期
                  </Button>
                ) : null}
                {isDone && onRollback ? (
                  <Button size="small" color="warning" startIcon={<UndoIcon />} onClick={() => onRollback(node.id)}>
                    回退节点
                  </Button>
                ) : null}
                <Tooltip title={open ? '收起环境参数' : '展开环境参数'}>
                  <IconButton size="small" onClick={() => setExpanded(open ? null : node.id)}>
                    <ExpandMoreIcon
                      fontSize="small"
                      sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s' }}
                    />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Collapse in={open} unmountOnExit>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" spacing={2} flexWrap="wrap" rowGap={0.5}>
                  {occupies.length > 0 ? (
                    <Typography variant="body2">
                      占用设备：{occupies.join('、')} · 时段 {fmtDateTime(node.planStart ?? node.startedAt)} ~{' '}
                      {fmtDateTime(slotEnd)}
                    </Typography>
                  ) : null}
                  <Typography variant="body2">工具：{node.tools.length ? node.tools.join('、') : '—'}</Typography>
                  <Typography variant="body2">磨料：{node.abrasive || '—'}</Typography>
                  <Typography variant="body2">
                    胶种：{node.adhesive || '—'}
                    {node.adhesiveConc > 0 ? `（浓度 ${node.adhesiveConc} %）` : ''}
                    {node.adhesiveIssueQty ? ` · 领用 ${node.adhesiveIssueQty}` : ''}
                  </Typography>
                  <Typography variant="body2">
                    环境：{node.tempC} ℃ / RH {node.rh} %
                  </Typography>
                  <Typography variant="body2">开始：{fmtTime(node.startedAt)}</Typography>
                  <Typography variant="body2">结束：{fmtTime(node.finishedAt)}</Typography>
                  <Typography variant="body2">
                    影像：前 {node.photoBeforeIds.length} 张 / 后 {node.photoAfterIds.length} 张
                  </Typography>
                  {onOpenPhoto ? (
                    <Button size="small" onClick={() => onOpenPhoto(node.id)}>
                      查看对照
                    </Button>
                  ) : null}
                </Stack>
              </Collapse>
            </Paper>
          </Box>
        );
      })}

      <Dialog open={!!rescheduling} onClose={() => setRescheduling(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          工序改期{rescheduling ? ` · #${rescheduling.seq} ${rescheduling.nodeName}` : ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              改期后旧时段占用立即作废，按新时段重新争用；若新时段已被先到方占用，本次改期不生效。
            </Typography>
            {rescheduleError ? <Alert severity="error">{rescheduleError}</Alert> : null}
            <TextField
              size="small"
              fullWidth
              type="datetime-local"
              label="新计划开始时段"
              value={newSlot}
              onChange={(e) => setNewSlot(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            {rescheduling ? (
              <Typography variant="caption" color="text.secondary">
                占用至 {fmtDateTime((Number.isFinite(fromLocalInput(newSlot)) ? fromLocalInput(newSlot) : 0) + rescheduling.durationMin * 60000)}
              </Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRescheduling(null)}>取消</Button>
          <Button variant="contained" onClick={confirmReschedule}>
            确认改期并重争用
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export default ProcedureTimeline;

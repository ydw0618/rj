import { useRef, useState, type DragEvent } from 'react';
import type { Task } from '../shared/contracts';
import { Empty, Icon, dateLabel } from './ui';

type Filter = 'all' | 'yes' | 'no';
const matches = (value: boolean, filter: Filter) => filter === 'all' || (filter === 'yes') === value;

export function TaskView({ tasks, ready, update, create, edit, remove, onError }: {
  tasks: Task[]; ready: boolean; update: (tasks: Task[]) => void; create: () => void; edit: (task: Task) => void; remove: (task: Task) => void;
  onError: (error: unknown) => void;
}) {
  const [importance, setImportance] = useState<Filter>('all');
  const [urgency, setUrgency] = useState<Filter>('all');
  const [status, setStatus] = useState<Filter>('all');
  const [dragTarget, setDragTarget] = useState<{ id: string; after: boolean } | null>(null);
  const drag = useRef<Task | null>(null);
  const visible = tasks.filter((task) => matches(task.important, importance) && matches(task.urgent, urgency) && matches(task.done, status));

  function move(source: Task, target: Task, after: boolean) {
    if (source.id === target.id || source.done !== target.done) return;
    const order = visible.filter((task) => task.done === source.done).map((task) => task.id);
    const previous = order.join();
    order.splice(order.indexOf(source.id), 1);
    order.splice(order.indexOf(target.id) + Number(after), 0, source.id);
    if (order.join() === previous) return;
    void window.workspace.reorderTasks(order).then(update, onError);
  }

  function dropPosition(event: DragEvent<HTMLElement>, task: Task) {
    if (!drag.current || drag.current.id === task.id || drag.current.done !== task.done) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return { id: task.id, after: event.clientY > bounds.y + bounds.height / 2 };
  }

  return <>
    <h1 className="sr-only">任务</h1>
    <div className="space-controls">
      <div className="filters task-filters">
      <select aria-label="筛选重要程度" value={importance} onChange={(event) => setImportance(event.target.value as Filter)}>
        <option value="all">重要程度：全部</option><option value="yes">重要</option><option value="no">不重要</option>
      </select>
      <select aria-label="筛选紧急程度" value={urgency} onChange={(event) => setUrgency(event.target.value as Filter)}>
        <option value="all">紧急程度：全部</option><option value="yes">紧急</option><option value="no">不紧急</option>
      </select>
      <select aria-label="筛选任务状态" value={status} onChange={(event) => setStatus(event.target.value as Filter)}>
        <option value="all">状态：全部</option><option value="no">未完成</option><option value="yes">已完成</option>
      </select>
      {tasks.some((task) => task.position !== null) && <button className="text-button" onClick={() => void window.workspace.resetTaskOrder().then(update, onError)}>恢复按截止时间排序</button>}
      </div>
      <button className="button primary" onClick={create}><Icon name="plus" size={17} />新建任务</button>
    </div>
    {ready && !visible.length && <Empty icon="task" title={tasks.length ? '没有符合条件的任务' : '还没有任务'}>
      {tasks.length ? <button className="button" onClick={() => { setImportance('all'); setUrgency('all'); setStatus('all'); }}>清除筛选</button>
        : <button className="button" onClick={create}><Icon name="plus" size={16} />新建任务</button>}
    </Empty>}
    <div className="task-list" aria-label="任务列表">
      {visible.map((task) => <article key={task.id} className={'task-row ' + (task.done ? 'done' : '')
        + (dragTarget?.id === task.id ? (dragTarget.after ? ' drop-after' : ' drop-before') : '')}
        onDragOver={(event) => {
          const position = dropPosition(event, task);
          if (!position) { setDragTarget(null); return; }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDragTarget((previous) => previous?.id === position.id && previous.after === position.after ? previous : position);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const position = dropPosition(event, task);
          if (drag.current && position) move(drag.current, task, position.after);
          drag.current = null;
          setDragTarget(null);
        }}>
        <button type="button" className="icon-button drag-handle" draggable title="拖动排序，或按方向键上下移动" aria-label={'排序 ' + task.title}
          onDragStart={(event) => { drag.current = task; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); }}
          onDragEnd={() => { drag.current = null; setDragTarget(null); }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const group = visible.filter((item) => item.done === task.done);
            const after = event.key === 'ArrowDown';
            const target = group[group.indexOf(task) + (after ? 1 : -1)];
            if (target) move(task, target, after);
          }}><Icon name="grip" size={18} /></button>
        <input type="checkbox" aria-label={task.done ? '重新开启 ' + task.title : '完成 ' + task.title} checked={task.done}
          onChange={(event) => void window.workspace.toggleTask(task.id, event.target.checked).catch(onError)} />
        <div className="task-info"><button className="text-button task-title" onClick={() => edit(task)}>{task.title}</button>
          <div className="task-details">
            {task.deadline && <span><Icon name="clock" size={13} />{dateLabel(task.deadline)}</span>}
            {task.source && <button className="text-button source-button" onClick={() => void window.workspace.openDocument(task.source!).catch(onError)}><Icon name="link" size={13} />{task.sourceTitle}</button>}
          </div>
        </div>
        {task.important && <span className="task-flag important">重要</span>}
        {task.urgent && <span className="task-flag urgent">紧急</span>}
        <button className="icon-button danger-action" title="删除任务" aria-label={'删除任务 ' + task.title} onClick={() => remove(task)}><Icon name="trash" size={16} /></button>
      </article>)}
    </div>
  </>;
}

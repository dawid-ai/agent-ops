import {
  Bookmark,
  Check,
  ChevronDown,
  Cpu,
  Folder,
  Search,
  Shapes,
  Tag,
  User,
  UserCog,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import { Button, Input, Toggle, cx } from '../components';
import type { Lanes, SavedView, TaskFilter } from '../lib/filters';
import { activeFilters, filterOptions, loadViews, storeViews, upsertView } from '../lib/filters';
import { identity, PRIORITIES } from '../lib/identity';
import type { Task } from '../types';
import { PriorityIcon, PriorityTag, ProviderMark, ROLE_ICONS, Who } from './identity';
import { Popover } from './pickers';

/** A filter chip with a dropdown of rich rows; `value` empty means the filter is off. */
export function FilterChip(props: {
  label: string;
  icon: ReactNode;
  value: string;
  display: ReactNode;
  options: Array<{ value: string; node: ReactNode }>;
  onChange: (v: string) => void;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const on = !!props.value;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'inline-flex h-[34px] items-center gap-2 rounded-lg border px-2.5 text-sm transition',
          on
            ? 'border-signal/35 bg-signal/8 text-fg'
            : 'border-white/10 bg-ink-950/60 text-fg-3 hover:border-white/20 hover:text-fg-2',
        )}
      >
        <span className={on ? 'text-signal' : 'text-fg-4'}>{props.icon}</span>
        {on ? props.display : <span>{props.label}</span>}
        {on ? (
          <span
            role="button"
            aria-label={`Clear ${props.label}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onChange('');
            }}
            className="-mr-1 rounded p-0.5 text-fg-3 hover:bg-white/10 hover:text-fg"
          >
            <X size={13} />
          </span>
        ) : (
          <ChevronDown size={13} className="text-fg-4" />
        )}
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={props.width ?? 230}
      >
        <div className="max-h-80 overflow-auto">
          <div className="label-caps px-2.5 pt-1.5 pb-1">{props.label}</div>
          {props.options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setOpen(false);
                props.onChange(o.value);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-fg-2 hover:bg-white/6 hover:text-fg"
            >
              <span className="min-w-0 flex-1">{o.node}</span>
              {o.value === props.value && <Check size={14} className="text-signal" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

const mono = (s: string) => <span className="font-mono text-xs">{s}</span>;

/**
 * Search plus a chip per filter that the tasks give values for, **Mine**, **Clear filters** and
 * **Save view**. `children` go first, for view-only filters such as the list's status.
 */
export function FilterBar(props: {
  tasks: Task[];
  filter: TaskFilter;
  onChange: (f: TaskFilter) => void;
  view: 'board' | 'list';
  lanes?: Lanes;
  children?: ReactNode;
}) {
  const { filter: f } = props;
  const o = useMemo(() => filterOptions(props.tasks), [props.tasks]);
  const set = (patch: TaskFilter) => props.onChange({ ...f, ...patch });
  const n = activeFilters(f);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-fg-4" />
        <Input
          value={f.text ?? ''}
          onChange={(text) => set({ text })}
          placeholder="Search id, title, project, label"
          className="w-64 pl-8"
        />
      </div>
      {props.children}
      {o.projects.length > 0 && (
        <FilterChip
          label="Project"
          icon={<Folder size={14} />}
          value={f.project ?? ''}
          display={mono(f.project ?? '')}
          onChange={(project) => set({ project })}
          options={o.projects.map((p) => ({ value: p, node: mono(p) }))}
        />
      )}
      <FilterChip
        label="Owner"
        icon={<User size={14} />}
        value={f.owner ?? ''}
        display={<Who id={f.owner ?? ''} size="xs" />}
        onChange={(owner) => set({ owner })}
        width={280}
        options={o.owners.map((x) => ({ value: x, node: <Who id={x} label /> }))}
      />
      {o.roles.length > 1 && (
        <FilterChip
          label="Role"
          icon={<UserCog size={14} />}
          value={f.role ?? ''}
          display={<RoleName role={f.role ?? ''} />}
          onChange={(role) => set({ role })}
          options={o.roles.map((r) => ({ value: r, node: <RoleName role={r} /> }))}
        />
      )}
      {o.providers.length > 1 && (
        <FilterChip
          label="Provider"
          icon={<Cpu size={14} />}
          value={f.provider ?? ''}
          display={<ProviderName p={f.provider ?? ''} />}
          onChange={(provider) => set({ provider })}
          options={o.providers.map((p) => ({ value: p, node: <ProviderName p={p} /> }))}
        />
      )}
      <FilterChip
        label="Priority"
        icon={<PriorityIcon p={f.priority || 'p1'} />}
        value={f.priority ?? ''}
        display={<PriorityTag p={f.priority ?? 'p2'} />}
        onChange={(priority) => set({ priority })}
        options={PRIORITIES.map((p) => ({ value: p.key, node: <PriorityTag p={p.key} /> }))}
      />
      {o.types.length > 1 && (
        <FilterChip
          label="Type"
          icon={<Shapes size={14} />}
          value={f.type ?? ''}
          display={<span className="text-xs">{f.type}</span>}
          onChange={(type) => set({ type })}
          options={o.types.map((t) => ({ value: t, node: <span className="text-xs">{t}</span> }))}
        />
      )}
      {o.labels.length > 0 && (
        <FilterChip
          label="Label"
          icon={<Tag size={14} />}
          value={f.label ?? ''}
          display={<span className="text-xs">{f.label}</span>}
          onChange={(label) => set({ label })}
          options={o.labels.map((l) => ({ value: l, node: <span className="text-xs">{l}</span> }))}
        />
      )}
      <Toggle checked={!!f.mine} onChange={(mine) => set({ mine })} label="Mine" />
      {n > 0 && (
        <button
          type="button"
          onClick={() => props.onChange({ ideas: f.ideas })}
          className="text-xs text-fg-4 transition hover:text-signal"
        >
          Clear filters
        </button>
      )}
      <SaveView filter={f} view={props.view} lanes={props.lanes} />
    </div>
  );
}

function RoleName({ role }: { role: string }) {
  const info = identity(`x:${role}`).roleInfo;
  const Icon = ROLE_ICONS[info.icon];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: info.color }}>
      <Icon size={13} /> {info.label}
    </span>
  );
}

function ProviderName({ p }: { p: string }) {
  const info = identity(`${p}:x`).provider;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: info.color }}>
      <ProviderMark runtime={p} size={13} /> {info.label}
    </span>
  );
}

/** Names the current filters (and lanes) as a view in the sidebar, stored on this machine. */
function SaveView(props: { filter: TaskFilter; view: 'board' | 'list'; lanes?: Lanes }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const anchor = useRef<HTMLSpanElement>(null);
  const save = (): void => {
    const v: SavedView = { name, view: props.view, filter: props.filter, lanes: props.lanes };
    storeViews(upsertView(loadViews(), v));
    setOpen(false);
    setName('');
  };
  return (
    <>
      <span ref={anchor} className="ml-auto">
        <Button size="sm" kind="ghost" icon={Bookmark} onClick={() => setOpen((x) => !x)}>
          Save view
        </Button>
      </span>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={260} align="end">
        <form
          className="space-y-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save();
          }}
        >
          <div className="label-caps">Save these filters as a view</div>
          <Input value={name} onChange={setName} placeholder="View name" className="w-full" />
          <div className="text-[11px] text-fg-4">
            Shows in the sidebar on this machine. A view with the same name is replaced.
          </div>
          <Button size="sm" kind="primary" type="submit" disabled={!name.trim()}>
            Save
          </Button>
        </form>
      </Popover>
    </>
  );
}

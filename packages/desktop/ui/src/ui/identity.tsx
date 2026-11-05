import type { LucideIcon } from 'lucide-react';
import {
  Asterisk,
  BookOpen,
  Bot,
  CodeXml,
  Compass,
  Database,
  Eye,
  Network,
  Palette,
  PenLine,
  Server,
  ShieldAlert,
  ShieldCheck,
  Telescope,
  User,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { RoleIcon } from '../lib/identity';
import { identity, priorityInfo, statusInfo } from '../lib/identity';

export const ROLE_ICONS: Record<RoleIcon, LucideIcon> = {
  engineer: CodeXml,
  qa: ShieldCheck,
  reviewer: Eye,
  pm: Compass,
  designer: Palette,
  docs: BookOpen,
  orchestrator: Network,
  writer: PenLine,
  research: Telescope,
  ops: Server,
  security: ShieldAlert,
  data: Database,
  person: User,
  any: Asterisk,
  bot: Bot,
};

/**
 * Each provider's mark, drawn for this app (not the vendors' logos): Claude a radial spark, Codex
 * a hexagon with a prompt, Gemini a four-point star, Grok a slash, a person a head and shoulders.
 */
export function ProviderMark({ runtime, size = 14 }: { runtime: string; size?: number }) {
  const color = identity(`${runtime}:x`).provider.color;
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (runtime) {
    case 'claude':
      return (
        <svg {...common}>
          {[0, 45, 90, 135].map((a) => (
            <line key={a} x1="12" y1="3" x2="12" y2="21" transform={`rotate(${a} 12 12)`} />
          ))}
          <circle cx="12" cy="12" r="2.2" fill={color} stroke="none" />
        </svg>
      );
    case 'codex':
      return (
        <svg {...common}>
          <path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5Z" />
          <path d="m8.5 9.5 2.5 2.5-2.5 2.5M12.5 15h3" />
        </svg>
      );
    case 'gemini':
      return (
        <svg {...common}>
          <path d="M12 2c.8 5.4 4.6 9.2 10 10-5.4.8-9.2 4.6-10 10-.8-5.4-4.6-9.2-10-10 5.4-.8 9.2-4.6 10-10Z" />
        </svg>
      );
    case 'grok':
      return (
        <svg {...common}>
          <path d="M5 19 19 5M5 5l5 5M14 14l5 5" />
        </svg>
      );
    case 'human':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c1.2-4 4.2-6 8-6s6.8 2 8 6" />
        </svg>
      );
    case '*':
      return (
        <svg {...common}>
          <path d="M12 4v16M5 8l14 8M19 8 5 16" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
          <text
            x="12"
            y="16.2"
            textAnchor="middle"
            fontSize="11"
            fontWeight="700"
            fill={color}
            stroke="none"
            fontFamily="Chakra Petch, sans-serif"
          >
            {runtime.charAt(0).toUpperCase()}
          </text>
        </svg>
      );
  }
}

/** A tile in the provider's color with its mark, and a role badge in the corner. */
export function Avatar({
  id,
  size = 26,
  live,
}: {
  id: string;
  size?: number;
  /** Shows a pulsing dot: a run is live. */
  live?: boolean;
}) {
  const who = identity(id);
  const RoleI = ROLE_ICONS[who.roleInfo.icon];
  const c = who.provider.color;
  const badge = Math.round(size * 0.52);
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-[30%]"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, color-mix(in oklab, ${c} 26%, #0d1117), color-mix(in oklab, ${c} 9%, #0d1117))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 38%, transparent), 0 0 14px -6px ${c}`,
      }}
      title={id}
    >
      <ProviderMark runtime={who.runtime} size={Math.round(size * 0.58)} />
      {!who.human && who.role && (
        <span
          className="absolute -right-1 -bottom-1 inline-flex items-center justify-center rounded-full"
          style={{
            width: badge,
            height: badge,
            background: '#0b0e14',
            boxShadow: `0 0 0 1.5px ${who.roleInfo.color}`,
          }}
        >
          <RoleI size={Math.round(badge * 0.62)} color={who.roleInfo.color} strokeWidth={2.4} />
        </span>
      )}
      {live && (
        <span
          className="animate-pulse-dot absolute -top-0.5 -left-0.5 h-2 w-2 rounded-full"
          style={{ background: '#3ddc97', color: '#3ddc97' }}
        />
      )}
    </span>
  );
}

/**
 * An agent or person: avatar, then the provider part in its color and the role in the role's
 * color. `plain` drops the avatar for dense rows.
 */
export function Who({
  id,
  size = 'sm',
  plain,
  live,
  label,
}: {
  id: string | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  plain?: boolean;
  live?: boolean;
  /** Show the role's display name (Engineer, QA) after the id. */
  label?: boolean;
}) {
  if (!id) return <span className="text-fg-4">-</span>;
  const who = identity(id);
  const px = size === 'xs' ? 16 : size === 'sm' ? 20 : 28;
  const text = size === 'md' ? 'text-sm' : 'text-xs';
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 align-middle ${text}`}>
      {!plain && <Avatar id={id} size={px} live={live} />}
      <span className="truncate font-mono">
        <span style={{ color: who.provider.color }}>{who.runtime}</span>
        {who.role && (
          <>
            <span className="text-fg-4">:</span>
            <span style={{ color: who.roleInfo.color }}>{who.role}</span>
          </>
        )}
      </span>
      {label && !who.human && who.role && who.role !== '*' && (
        <span className="text-fg-3">{who.roleInfo.label}</span>
      )}
    </span>
  );
}

/** A tag-shaped chip for an id, used inside pickers; `onRemove` adds a remove button. */
export function AgentTag({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const who = identity(id);
  const c = who.provider.color;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-xs"
      style={{
        background: `color-mix(in oklab, ${c} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 32%, transparent)`,
      }}
    >
      <Avatar id={id} size={18} />
      <span className="font-mono">
        <span style={{ color: c }}>{who.runtime}</span>
        {who.role && (
          <>
            <span className="text-fg-4">:</span>
            <span style={{ color: who.roleInfo.color }}>{who.role}</span>
          </>
        )}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-1 rounded-full px-1 text-fg-3 hover:bg-white/10 hover:text-fg"
          aria-label={`Remove ${id}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Signal bars for a priority; Urgent is a filled alert tile. */
export function PriorityIcon({ p, size = 14 }: { p: string; size?: number }) {
  const info = priorityInfo(p);
  if (info.key === 'p0') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-label={info.label}>
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill={info.color} />
        <rect x="7.1" y="3.8" width="1.8" height="5.6" rx="0.9" fill="#05070a" />
        <circle cx="8" cy="11.6" r="1.1" fill="#05070a" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={info.label}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 4.5}
          y={10 - i * 3.5}
          width="3"
          height={4 + i * 3.5}
          rx="1"
          fill={i < info.bars ? info.color : '#273042'}
        />
      ))}
    </svg>
  );
}

export function PriorityTag({ p, compact }: { p: string; compact?: boolean }) {
  const info = priorityInfo(p);
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium"
      style={{ color: info.key === 'p3' ? '#7f8899' : info.color }}
      title={`${info.label} (${info.key})`}
    >
      <PriorityIcon p={p} />
      {!compact && info.label}
    </span>
  );
}

/** A status glyph: ring for to do, dashed for claimed, half for in progress, and so on. */
export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const { color } = statusInfo(status);
  const s = { width: size, height: size, viewBox: '0 0 16 16' };
  switch (status) {
    case 'claimed':
      return (
        <svg {...s}>
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeDasharray="3 2.4"
          />
        </svg>
      );
    case 'in-progress':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7Z" fill={color} />
        </svg>
      );
    case 'blocked':
      return (
        <svg {...s}>
          <path
            d="M5.5 1.8h5l3.7 3.7v5l-3.7 3.7h-5L1.8 10.5v-5Z"
            fill="none"
            stroke={color}
            strokeWidth="1.8"
          />
          <path d="M5.5 8h5" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'needs-review':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
          <circle cx="8" cy="8" r="2.2" fill={color} />
        </svg>
      );
    case 'done':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="7" fill={color} />
          <path
            d="m4.8 8.2 2.2 2.2 4.2-4.6"
            fill="none"
            stroke="#05070a"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'parked':
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
          <path d="M5 11 11 5" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2" />
        </svg>
      );
  }
}

export function StatusTag({
  status,
  stale,
  unblocked,
}: {
  status: string;
  stale?: boolean;
  unblocked?: boolean;
}) {
  const shown = stale || unblocked ? 'todo' : status;
  const info = statusInfo(shown);
  const style: CSSProperties = {
    color: info.color,
    background: `color-mix(in oklab, ${info.color} 11%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${info.color} 26%, transparent)`,
  };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={style}
    >
      <StatusIcon status={shown} size={12} />
      {info.label}
      {stale && <span className="text-warn">· stale claim</span>}
      {unblocked && <span className="text-ok">· unblocked</span>}
    </span>
  );
}

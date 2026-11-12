// 监控台: what the back end is doing, line by line, to debug with and to watch it run. The lines are kept in the
// main process (main/monitor.ts, secrets removed there); this page reads them when it opens and gets the new ones
// in batches while it is open. Filters by source and level, a search, 暂停滚动, copy a line, export.
//
// Everything a line holds (a model's answer, a tool's output, a plugin's stderr) is shown as plain text: React text
// nodes only, never HTML or Markdown.
//
// Only the rows in sight are drawn (fixed row height), so thousands of lines do not slow the page.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MONITOR_LEVELS, MONITOR_SOURCES, monitorLine, type MonitorEntry, type MonitorLevel, type MonitorSource } from '../../../shared/monitor';
import type { SaveCsvResult } from '../../../shared/bridge';
import { Icon } from '../ui/Icon';
import { clipboard } from '../ui/clipboard';
import { ContextMenu } from '../ui/ContextMenu';

export interface MonitorApi {
  list(after: number): Promise<MonitorEntry[]>;
  /** A line's whole text (absent: the line is all there is). */
  full?(seq: number): Promise<string | null>;
  watch(listener: (entries: MonitorEntry[]) => void): () => void;
  export(text: string): Promise<SaveCsvResult>;
}

export interface MonitorViewProps {
  api: MonitorApi;
  /** Shows where an exported file went (in Explorer). */
  showInFolder?: (path: string) => void;
}

/** As many lines as the main process keeps. */
const KEEP = 5000;
export const ROW_H = 24;
/** Rows drawn above and below the ones in sight. */
const OVERSCAN = 20;

type LevelFilter = 'all' | 'warn' | 'error';
const LEVEL_RANK: Record<MonitorLevel, number> = { info: 0, warn: 1, error: 2 };

/** The lines the filters let through. */
export function filterEntries(entries: readonly MonitorEntry[], sources: ReadonlySet<MonitorSource>, level: LevelFilter, query: string): MonitorEntry[] {
  const q = query.trim().toLowerCase();
  const min = level === 'all' ? 0 : LEVEL_RANK[level];
  return entries.filter((e) => sources.has(e.source) && LEVEL_RANK[e.level] >= min && (!q || e.text.toLowerCase().includes(q)));
}

/** The source button's words: 全部来源, the one or two picked, or how many. */
export function sourcesLabel(sources: ReadonlySet<MonitorSource>): string {
  if (sources.size === MONITOR_SOURCES.length) return '全部来源';
  if (sources.size === 0) return '无来源';
  const names = MONITOR_SOURCES.filter(([s]) => sources.has(s)).map(([, l]) => l);
  return names.length <= 2 ? names.join('、') : `${names.length} 个来源`;
}

/** 14:05:09.123 in local time. */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function MonitorView({ api, showInFolder }: MonitorViewProps) {
  const [entries, setEntries] = useState<MonitorEntry[]>([]);
  const [sources, setSources] = useState<Set<MonitorSource>>(() => new Set(MONITOR_SOURCES.map(([s]) => s)));
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [exported, setExported] = useState<SaveCsvResult | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 480 });
  // what came while paused: shown in the 继续 button, the list does not move
  const [unseen, setUnseen] = useState(0);
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // while paused, new lines wait here: added to the list they would push the oldest out and move what is in sight
  const held = useRef<MonitorEntry[]>([]);
  const append = useCallback((fresh: MonitorEntry[]) => {
    setEntries((now) => {
      const next = now.concat(fresh);
      return next.length > KEEP ? next.slice(next.length - KEEP) : next;
    });
  }, []);
  useEffect(() => {
    let live = true;
    let last = 0;
    const take = (more: MonitorEntry[]) => {
      const fresh = more.filter((e) => e.seq > last);
      if (!fresh.length) return;
      last = fresh[fresh.length - 1]!.seq;
      if (pausedRef.current) {
        held.current = held.current.concat(fresh).slice(-KEEP);
        setUnseen((n) => n + fresh.length);
      } else append(fresh);
    };
    // listen first, then read what is kept: nothing falls in between (the seq drops what came twice)
    const off = api.watch((batch) => live && take(batch));
    void api.list(0).then((all) => live && take(all), () => undefined);
    return () => {
      live = false;
      off();
    };
  }, [api, append]);

  const shown = useMemo(() => filterEntries(entries, sources, level, query), [entries, sources, level, query]);

  // follow the end unless paused
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || paused) return;
    el.scrollTop = el.scrollHeight;
    setScroll({ top: el.scrollTop, height: el.clientHeight });
  }, [shown.length, paused]);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      // a smaller window: still at the end unless paused
      if (!pausedRef.current) el.scrollTop = el.scrollHeight;
      setScroll({ top: el.scrollTop, height: el.clientHeight || 480 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    setScroll({ top: el.scrollTop, height: el.clientHeight || 480 });
    // scrolled up by hand: stop following, as 暂停滚动 does; back at the end: follow again
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H;
    if (!atEnd && !pausedRef.current) pause();
  };

  const resume = () => {
    pausedRef.current = false;
    setPaused(false);
    setUnseen(0);
    const waiting = held.current;
    held.current = [];
    if (waiting.length) append(waiting);
  };
  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
  };

  const toggleSource = (s: MonitorSource) =>
    setSources((now) => {
      const next = new Set(now);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const copy = useCallback((e: MonitorEntry) => {
    void clipboard.write(monitorLine(e)).then(
      () => {
        setCopied(e.seq);
        setTimeout(() => setCopied((c) => (c === e.seq ? null : c)), 1500);
      },
      () => undefined,
    );
  }, []);

  const doExport = async () => {
    const r = await api.export(shown.map(monitorLine).join('\n') + '\n').catch(() => ({ error: '无法导出日志。' }));
    setExported(r ?? undefined);
  };

  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((scroll.top + scroll.height) / ROW_H) + OVERSCAN);
  const rows = shown.slice(first, last);
  const sel = selected === null ? undefined : shown.find((e) => e.seq === selected);
  // the picked line in full: asked for when picked (the list holds lines, the whole of a tool's result is kept apart)
  const [whole, setWhole] = useState<{ seq: number; text: string } | null>(null);
  useEffect(() => {
    if (selected === null || !api.full) return;
    let live = true;
    void api.full(selected).then(
      (t) => live && t !== null && setWhole({ seq: selected, text: t }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, selected]);
  const selText = sel ? (whole?.seq === sel.seq ? whole.text : sel.text) : '';

  return (
    <div className="monitor">
      <div className="monitor-bar">
        <button
          type="button"
          className="btn btn-small monitor-sources"
          aria-haspopup="menu"
          onClick={(ev) => {
            const el = ev.currentTarget;
            setMenu((now) => (now ? null : el));
          }}
        >
          {sourcesLabel(sources)}
          <Icon name="chevronDown" size={12} />
        </button>
        <div className="segmented" role="radiogroup" aria-label="级别">
          {(
            [
              ['all', '全部'],
              ['warn', MONITOR_LEVELS[1]![1]],
              ['error', MONITOR_LEVELS[2]![1]],
            ] as const
          ).map(([l, label]) => (
            <button key={l} type="button" role="radio" aria-checked={level === l} className={level === l ? 'segment is-on' : 'segment'} onClick={() => setLevel(l)}>
              {label}
            </button>
          ))}
        </div>
        <div className="monitor-search">
          <Icon name="search" size={14} className="monitor-search-icon" />
          <input className="input" type="search" value={query} placeholder="搜索" aria-label="搜索" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="monitor-count">{`${shown.length.toLocaleString('en-US')} 条`}</span>
        <button type="button" className="btn btn-small" onClick={paused ? resume : pause}>
          {paused ? (unseen ? `继续（${unseen} 条新）` : '继续') : '暂停滚动'}
        </button>
        <button type="button" className="btn btn-small" onClick={() => void doExport()} disabled={!shown.length}>
          导出…
        </button>
      </div>
      {exported && 'error' in exported ? <p className="monitor-note is-bad">{exported.error}</p> : null}
      {exported && 'file' in exported ? (
        <p className="monitor-note">
          已导出：
          {showInFolder ? (
            <button type="button" className="path-text path-link monitor-path" title={`在文件夹中显示：${exported.file}`} onClick={() => showInFolder(exported.file)}>
              {exported.file}
            </button>
          ) : (
            exported.file
          )}
        </p>
      ) : null}
      <div className="monitor-list" ref={list} onScroll={onScroll} role="log" aria-live="off" aria-label="日志">
        {shown.length ? (
          <div className="monitor-rows" style={{ height: shown.length * ROW_H }}>
            {rows.map((e, i) => (
              <div
                key={e.seq}
                className={['monitor-row', `is-${e.level}`, selected === e.seq ? 'is-selected' : ''].filter(Boolean).join(' ')}
                style={{ top: (first + i) * ROW_H }}
                onClick={() => setSelected((s) => (s === e.seq ? null : e.seq))}
              >
                <span className="monitor-time">{clockOf(e.at)}</span>
                <span className="monitor-source">{MONITOR_SOURCES.find(([s]) => s === e.source)?.[1]}</span>
                <span className="monitor-level">{MONITOR_LEVELS.find(([l]) => l === e.level)?.[1]}</span>
                <span className="monitor-text">{e.text}</span>
                <button
                  type="button"
                  className="icon-btn monitor-copy"
                  aria-label="复制这一行"
                  title={copied === e.seq ? '已复制' : '复制这一行'}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    copy(e);
                  }}
                >
                  <Icon name={copied === e.seq ? 'check' : 'copy'} size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="monitor-empty">{entries.length ? '没有符合条件的日志' : '暂无日志'}</p>
        )}
      </div>
      {menu ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={menu}
          items={MONITOR_SOURCES.map(([s, label]) => ({ label, checked: sources.has(s), onSelect: () => toggleSource(s) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {sel ? (
        <div className="monitor-detail">
          <div className="monitor-detail-head">
            <span className="monitor-time">{`${sel.at.slice(0, 10)} ${clockOf(sel.at)}`}</span>
            <span className="monitor-source">{MONITOR_SOURCES.find(([s]) => s === sel.source)?.[1]}</span>
            <span className="monitor-level">{MONITOR_LEVELS.find(([l]) => l === sel.level)?.[1]}</span>
            <button type="button" className="btn btn-small" onClick={() => copy({ ...sel, text: selText })}>
              {copied === sel.seq ? '已复制' : '复制'}
            </button>
            <button type="button" className="icon-btn" aria-label="关闭" title="关闭" onClick={() => setSelected(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <pre className="monitor-detail-text">{selText}</pre>
        </div>
      ) : null}
    </div>
  );
}

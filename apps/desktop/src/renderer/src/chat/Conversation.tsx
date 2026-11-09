// The main pane: the transcript of one session, streamed live, and its input box.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@spica/protocol';
import { filesOf, isRunning, type Block, type Item, type Transcript } from '../store/transcript';
import { SpicaMark } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { AskCard, ConfirmCard, FileCards, MarkdownText, SuggestCard, ThinkingBlock, ToolGroup } from './Blocks';
import { Composer } from './Composer';
import { StatusLine } from './StatusLine';

export interface ConversationActions {
  send(text: string): void;
  stop(): void;
  answer(callId: string, answer: string): void;
  confirm(callId: string, approved: boolean): void;
  openFile(path: string): void;
}

type Segment = { kind: 'tools'; blocks: Extract<Block, { type: 'tool' }>[] } | { kind: 'one'; block: Exclude<Block, { type: 'tool' }> };

function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = [];
  for (const b of blocks) {
    if (b.type === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools') last.blocks.push(b);
      else out.push({ kind: 'tools', blocks: [b] });
    } else out.push({ kind: 'one', block: b });
  }
  return out;
}

function Response({ item, live, actions }: { item: Extract<Item, { kind: 'response' }>; live: boolean; actions: ConversationActions }) {
  const segs = segments(item.blocks);
  const files = filesOf(item.blocks);
  return (
    <div className="turn-response">
      {segs.map((s, i) => {
        if (s.kind === 'tools') return <ToolGroup key={s.blocks[0]?.callId ?? i} blocks={s.blocks} />;
        const b = s.block;
        switch (b.type) {
          case 'text':
            return <MarkdownText key={i} text={b.text} />;
          case 'thinking':
            return <ThinkingBlock key={i} text={b.text} live={live && i === segs.length - 1} />;
          case 'ask':
            return <AskCard key={b.callId} block={b} onAnswer={(a) => actions.answer(b.callId, a)} />;
          case 'confirm':
            return <ConfirmCard key={b.callId} block={b} onDecide={(ok) => actions.confirm(b.callId, ok)} />;
          case 'suggest':
            return live ? null : <SuggestCard key={b.callId} block={b} onPick={actions.send} />;
          default:
            return null;
        }
      })}
      {live ? null : <FileCards files={files} onOpen={actions.openFile} />}
      {item.interrupted ? <p className="turn-note">已停止</p> : null}
    </div>
  );
}

function EmptyState({ session }: { session: SessionInfo | undefined }) {
  return (
    <div className="empty-chat">
      <SpicaMark size={56} />
      <p className="empty-chat-title">{session?.role === 'top' || !session ? '有什么要我做的？' : session.title}</p>
    </div>
  );
}

/** Keeps the view pinned to the bottom while new text streams in, unless the user scrolled up. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only the user's own scrolling may unpin; layout changes (resize, zoom,
    // re-wrapping) also fire scroll events and must not.
    let userUntil = 0;
    const markUser = () => {
      userUntil = performance.now() + 800;
    };
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom) stick.current = true;
      else if (performance.now() < userUntil) stick.current = false;
      else if (stick.current) el.scrollTop = el.scrollHeight;
      setAway(!stick.current);
    };
    const userEvents = ['wheel', 'pointerdown', 'keydown', 'touchmove'] as const;
    for (const t of userEvents) el.addEventListener(t, markUser, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    // Resizing the window or zooming re-wraps text; stay at the bottom if we were there.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    }) : undefined;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', onScroll);
      for (const t of userEvents) el.removeEventListener(t, markUser);
      ro?.disconnect();
    };
  }, []);
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight });
  };
  return { ref, away, toBottom };
}

export interface ConversationProps {
  session: SessionInfo | undefined;
  transcript: Transcript;
  actions: ConversationActions;
  /** Show that answers are demo data (no model configured). */
  demo?: boolean;
}

export function Conversation({ session, transcript, actions, demo }: ConversationProps) {
  const running = isRunning(transcript.run?.status) || isRunning(session?.status);
  const { ref, away, toBottom } = useStickToBottom(transcript);
  const items = transcript.items;
  const lastIndex = items.length - 1;
  return (
    <div className="conversation">
      <div className="transcript" ref={ref}>
        {items.length === 0 && !running ? (
          <EmptyState session={session} />
        ) : (
          <div className="transcript-column">
            {items.map((item, i) => {
              if (item.kind === 'user')
                return (
                  <div key={item.id} className={item.steer ? 'turn-user is-steer' : 'turn-user'}>
                    {item.steer ? <span className="turn-user-tag">插话</span> : null}
                    <p className="turn-user-text">{item.text}</p>
                  </div>
                );
              if (item.kind === 'note')
                return (
                  <p key={item.id} className="turn-note">
                    {item.text}
                  </p>
                );
              return <Response key={item.id} item={item} live={running && i === lastIndex} actions={actions} />;
            })}
            <StatusLine transcript={transcript} />
            {transcript.error ? (
              <p className="turn-error" role="alert">
                {transcript.error}
              </p>
            ) : null}
          </div>
        )}
      </div>
      {away ? (
        <button type="button" className="to-bottom" onClick={toBottom} aria-label="回到最新">
          <Icon name="chevronDown" size={16} />
        </button>
      ) : null}
      <Composer running={running} onSend={actions.send} onStop={actions.stop} sessionKey={session?.id ?? ''} />
      {demo ? <p className="composer-note">还没有配置模型，现在的回答是演示数据</p> : null}
    </div>
  );
}

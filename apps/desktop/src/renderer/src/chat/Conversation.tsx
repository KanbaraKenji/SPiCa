// The main pane: the transcript of one session, streamed live, and its input box.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MailItem, SessionInfo } from '@spica/protocol';
import { filesOf, isRunning, type Block, type Item, type Transcript } from '../store/transcript';
import { SpicaMark } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { AskCard, ChildNoteCard, ConfirmCard, FileCards, MarkdownText, SuggestCard, ThinkingBlock, ToolGroup } from './Blocks';
import { Composer } from './Composer';
import { StatusLine } from './StatusLine';

export interface ConversationActions {
  send(text: string): void;
  stop(): void;
  answer(callId: string, answer: string): void;
  confirm(callId: string, approved: boolean): void;
  openFile(path: string): void;
  openSession(id: string): void;
  resume(): void;
  /** Mail by id, for 「收到来信」 in a project's conversation. */
  mailById?: (id: string) => MailItem | undefined;
  openInbox?: () => void;
}

function MailNote({ ids, actions }: { ids: string[]; actions: ConversationActions }) {
  const mails = ids.map((id) => actions.mailById?.(id)).filter((m): m is MailItem => m !== undefined);
  return (
    <div className="turn-mail">
      <p className="turn-mail-head">
        <Icon name="inbox" size={14} />
        <span>收到 {ids.length} 封来信</span>
        {actions.openInbox ? (
          <button type="button" className="text-btn" onClick={actions.openInbox}>
            去收件箱
          </button>
        ) : null}
      </p>
      {mails.length ? (
        <ul className="turn-mail-list">
          {mails.map((m) => (
            <li key={m.id}>
              <span className="turn-mail-from">{m.fromName || m.fromAddress || '—'}</span>
              <span className="turn-mail-subject">{m.subject || '（没有主题）'}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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

function Response({ item, live, actions, cards }: { item: Extract<Item, { kind: 'response' }>; live: boolean; actions: ConversationActions; cards: Transcript['fileCards'] }) {
  const segs = segments(item.blocks);
  const files = filesOf(item.blocks, cards);
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
      {item.interrupted ? <p className="turn-note">（中断）</p> : null}
    </div>
  );
}

function EmptyState({ session, needsModel, onSetupModel }: { session: SessionInfo | undefined; needsModel: boolean; onSetupModel?: () => void }) {
  if (needsModel)
    return (
      <div className="empty-chat">
        <SpicaMark size={56} />
        <p className="empty-chat-title">还没有配置模型</p>
        <button type="button" className="btn btn-primary" onClick={onSetupModel}>
          去设置模型
        </button>
      </div>
    );
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
  /** Show that answers are demo data (screenshots, tests). */
  demo?: boolean;
  /** No model is configured yet: the empty state points to settings. */
  needsModel?: boolean;
  onSetupModel?: () => void;
  /** Sub-agents under this conversation that wait for the user (a question or a confirmation). */
  waiting?: WaitingChild[];
}

export interface WaitingChild {
  id: string;
  title: string;
  status: 'awaiting_confirm' | 'awaiting_answer';
}

export function Conversation({ session, transcript, actions, demo, needsModel = false, onSetupModel, waiting = [] }: ConversationProps) {
  const running = isRunning(transcript.run?.status) || isRunning(session?.status);
  const { ref, away, toBottom } = useStickToBottom(transcript);
  const items = transcript.items;
  const lastIndex = items.length - 1;
  return (
    <div className="conversation">
      <div className="transcript" ref={ref}>
        {items.length === 0 && !running ? (
          <EmptyState session={session} needsModel={needsModel} {...(onSetupModel ? { onSetupModel } : {})} />
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
              if (item.kind === 'mail') return <MailNote key={item.id} ids={item.mailIds} actions={actions} />;
              if (item.kind === 'note')
                return item.child ? (
                  <ChildNoteCard key={item.id} note={item.child} onOpen={actions.openSession} />
                ) : (
                  <p key={item.id} className="turn-note">
                    {item.text}
                  </p>
                );
              return <Response key={item.id} item={item} live={running && i === lastIndex} actions={actions} cards={transcript.fileCards} />;
            })}
            <StatusLine transcript={transcript} />
            {waiting.map((w) => (
              <div key={w.id} className="resume-row waiting-row" role="status">
                <span>
                  「{w.title}」{w.status === 'awaiting_confirm' ? '在等你确认' : '在等你回答'}
                </span>
                <button type="button" className="btn" onClick={() => actions.openSession(w.id)}>
                  去处理
                </button>
              </div>
            ))}
            {session?.status === 'interrupted' && !running ? (
              <div className="resume-row">
                <span>上次没做完就中断了</span>
                <button type="button" className="btn" onClick={actions.resume}>
                  继续
                </button>
              </div>
            ) : null}
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
      {transcript.queued?.length ? (
        <div className="queued" aria-live="polite">
          {transcript.queued.map((q) => (
            <p key={q.id} className="queued-item">
              <span className="queued-tag">下一步生效</span>
              <span className="queued-text">{q.text}</span>
            </p>
          ))}
        </div>
      ) : null}
      <Composer running={running} onSend={actions.send} onStop={actions.stop} sessionKey={session?.id ?? ''} />
      {demo ? <p className="composer-note">现在的回答是演示数据</p> : null}
    </div>
  );
}

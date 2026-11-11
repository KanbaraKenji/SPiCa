// The main pane: the transcript of one session, streamed live, and its input box.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CwdChangeMeta, MailItem, RegenerateState, SessionInfo } from '@spica/protocol';
import { changesAfter } from '../store/relocate';
import { filesOf, historyRef, isRunning, itemAtSeq, type Attachment, type Block, type Item, type Transcript } from '../store/transcript';
import { ImageViewer } from '../ui/ImageViewer';
import { SpicaMark, SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { AnswerSources, AnswerToolsContext, AskCard, ChildNoteCard, ConfirmCard, FileCards, HistoryCardsContext, SourceCardsContext, ToolCardsContext, HistoryRefContext, MarkdownText, OpenSessionContext, SuggestCard, ThinkingBlock, ToolGroup } from './Blocks';
import { Composer, type ComposerTools } from './Composer';
import { answerText, MessageActions } from './MessageActions';
import { answerSources } from './sources';
import { StatusLine } from './StatusLine';
import { GUARD_FLAG_TEXT } from './format';
import { SettingsChangeCard } from './SettingsChangeCard';

export interface ConversationActions {
  send(text: string, attachments?: string[]): void;
  stop(): void;
  answer(callId: string, answer: string): void;
  confirm(callId: string, approved: boolean): void;
  openFile(path: string): void;
  /** A folder path clicked in an answer: opened in Explorer. */
  openFolder?: (path: string) => void;
  /** 打开所在文件夹 on a file card (an absolute path). */
  revealFile?: (path: string) => void;
  /** 导出 CSV on a table in an answer; resolves to whether it was saved. */
  saveCsv?: (text: string) => Promise<boolean>;
  openSession(id: string): void;
  /** From a history row or link: opens that conversation at message number `seq`, with a way back. */
  openFound?: (id: string, seq?: number) => void;
  resume(): void;
  /** Mail by id, for 「收到来信」 in a project's conversation. */
  mailById?: (id: string) => MailItem | undefined;
  openInbox?: () => void;
  /** 设置 › 模型 (from a settings-change card). */
  openModelSettings?: () => void;
  /** A URL to show a sent picture. */
  imageUrl?: (path: string) => Promise<string>;
  /** 重新生成 the last answer (`messageId`: the answer it was clicked under). */
  regenerate?: (messageId?: string) => void;
}

/** Why a picture was not sent, in words. */
const IMAGE_CODE_TEXT: Record<NonNullable<Attachment['code']>, string> = {
  'image.too_large': '图片过大，未发送',
  'image.too_many': '图片数量超过上限，未发送',
  'image.unreadable': '无法读取图片，未发送',
};

/** A sent picture under the message: a thumbnail, full size on a click. */
function SentPicture({ a, url }: { a: Attachment; url?: (path: string) => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const path = a.image?.path ?? '';
  useEffect(() => {
    let alive = true;
    if (path && url) void url(path).then((u) => alive && setSrc(u)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, url]);
  return (
    <>
      <button type="button" className="turn-picture" onClick={() => src && setOpen(true)} aria-label={`查看 ${a.name}`} title={a.name}>
        {src ? <img src={src} alt="" /> : null}
      </button>
      {open && src ? <ImageViewer url={src} name={a.name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function MailNote({ ids, flagged = [], actions }: { ids: string[]; flagged?: string[] | undefined; actions: ConversationActions }) {
  const mails = ids.map((id) => actions.mailById?.(id)).filter((m): m is MailItem => m !== undefined);
  return (
    <div className="turn-mail">
      <p className="turn-mail-head">
        <Icon name="inbox" size={14} />
        <span>收到 {ids.length} 封来信</span>
        {actions.openInbox ? (
          <button type="button" className="text-btn" onClick={actions.openInbox}>
            打开收件箱
          </button>
        ) : null}
      </p>
      {mails.length ? (
        <ul className="turn-mail-list">
          {mails.map((m) => (
            <li key={m.id}>
              <span className="turn-mail-from">{m.fromName || m.fromAddress || '—'}</span>
              <span className="turn-mail-subject">{m.subject || '（无主题）'}</span>
              {flagged.includes(m.id) ? <span className="guard-note">{GUARD_FLAG_TEXT.mail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 打开所在文件夹 and 复制路径 on file cards, where Explorer can be reached. */
function fileActions(actions: ConversationActions, cwd: string | undefined) {
  return actions.revealFile ? { reveal: actions.revealFile, cwd, imageUrl: actions.imageUrl } : undefined;
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

/** `since`: the run's start, while this answer is the one being written (its last line then says what the run is doing, with the clock). */
function Response({
  item,
  live,
  since,
  actions,
  cards,
  moved,
  at,
  regen,
  after,
  cwd,
  lists,
  sources,
}: {
  item: Extract<Item, { kind: 'response' }>;
  live: boolean;
  since?: number | undefined;
  actions: ConversationActions;
  cards: Transcript['fileCards'];
  lists?: Transcript['fileCardLists'];
  sources?: Transcript['sourceCards'];
  moved?: CwdChangeMeta;
  /** The conversation's working folder (a relative path on a file card is in it). */
  cwd?: string | undefined;
  at?: Record<string, string>;
  regen?: { state: RegenerateState; last: boolean } | undefined;
  /** How many items follow it in the conversation. */
  after: number;
}) {
  // The answers 重新生成 left, oldest first, then this one; the newest shows unless another is picked.
  const all = [...(item.versions ?? []), { blocks: item.blocks, at: item.at }];
  const [picked, setPicked] = useState<number | null>(null);
  const [count, setCount] = useState(all.length);
  const [seenAfter, setSeenAfter] = useState(after);
  if (count !== all.length || seenAfter !== after) {
    // A new answer came, or a message was sent after this one: back to the newest (the conversation goes on from it).
    setCount(all.length);
    setSeenAfter(after);
    setPicked(null);
  }
  const shown = picked ?? all.length - 1;
  const newest = shown === all.length - 1;
  const view = all[shown]!;
  const blocks = view.blocks;
  const segs = segments(blocks);
  const files = filesOf(blocks, cards, moved, lists);
  return (
    <div className="turn-response" {...at}>
      {segs.map((s, i) => {
        if (s.kind === 'tools') {
          // Outside content that carried instructions: one quiet line per kind, under the tools.
          const kinds = [...new Set(s.blocks.map((b) => b.flagged).filter((k): k is NonNullable<typeof k> => Boolean(k)))];
          return (
            <Fragment key={s.blocks[0]?.callId ?? i}>
              <ToolGroup blocks={s.blocks} since={live && i === segs.length - 1 ? since : undefined} />
              {kinds.map((k) => (
                <p key={k} className="turn-note guard-note status-with-icon">
                  <SpicaStatusIcon name="info" size={14} />
                  {GUARD_FLAG_TEXT[k]}
                </p>
              ))}
            </Fragment>
          );
        }
        const b = s.block;
        switch (b.type) {
          case 'text':
            return <MarkdownText key={i} text={b.text} />;
          case 'thinking':
            return <ThinkingBlock key={i} text={b.text} live={live && i === segs.length - 1} since={live && i === segs.length - 1 ? since : undefined} />;
          case 'ask':
            return <AskCard key={b.callId} block={b} onAnswer={(a) => actions.answer(b.callId, a)} />;
          case 'confirm':
            return <ConfirmCard key={b.callId} block={b} onDecide={(ok) => actions.confirm(b.callId, ok)} />;
          case 'suggest':
            // Not on an older answer: the next message always follows the newest one.
            return live || !newest ? null : <SuggestCard key={b.callId} block={b} onPick={actions.send} />;
          default:
            return null;
        }
      })}
      {live ? null : <AnswerSources sources={answerSources(blocks, sources)} />}
      {live ? null : <FileCards files={files} onOpen={actions.openFile} actions={fileActions(actions, cwd)} />}
      {item.interrupted && newest ? <p className="turn-note">（中断）</p> : null}
      {live ? null : (
        <MessageActions
          text={answerText(blocks)}
          at={view.at}
          versions={all.length > 1 ? { shown, count: all.length, onShow: (n) => setPicked(n === all.length - 1 ? null : n) } : undefined}
          regenerate={
            // Only under the last round's answer (the one the core would replace); earlier ones keep 复制 and the time.
            regen?.last && actions.regenerate && newest
              ? {
                  state: regen.state,
                  onRegenerate: () => {
                    setPicked(null);
                    actions.regenerate?.(item.messageIds?.[item.messageIds.length - 1]);
                  },
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function EmptyState({ session, needsModel, onSetupModel }: { session: SessionInfo | undefined; needsModel: boolean; onSetupModel?: () => void }) {
  if (needsModel)
    return (
      <div className="empty-chat">
        <SpicaMark size={56} />
        <p className="empty-chat-title">未配置模型</p>
        <button type="button" className="btn btn-primary" onClick={onSetupModel}>
          设置模型
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
  /** Stop following new text (the view was moved to a found message on purpose); 回到最新 shows once it scrolled. */
  const unpin = () => {
    stick.current = false;
  };
  return { ref, away, toBottom, unpin };
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
  /** Controls in the input box (attachments, folder, approval, model, context). */
  composerTools?: ComposerTools;
  /** Opened from a history row or link: the message to scroll to and mark, and the way back. */
  found?: { seq?: number; back?: { title: string; onBack(): void } };
}

export interface WaitingChild {
  id: string;
  title: string;
  status: 'awaiting_confirm' | 'awaiting_answer';
}

export function Conversation({ session, transcript, actions, demo, needsModel = false, onSetupModel, waiting = [], composerTools, found }: ConversationProps) {
  const running = isRunning(transcript.run?.status) || isRunning(session?.status);
  const { ref, away, toBottom, unpin } = useStickToBottom(transcript);
  const items = transcript.items;
  // Answers before the working-folder note: their files are where that note moved them (or left them).
  const moves = useMemo(() => changesAfter(items), [items]);
  const lastIndex = items.length - 1;
  // The core's word on 重新生成 for the last round.
  const regen = session?.regenerate;
  // Opened at a found message: the item that holds it, scrolled to once it is there, and marked.
  const foundItem = found?.seq !== undefined ? itemAtSeq(transcript, found.seq) : undefined;
  const scrolledTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!foundItem || scrolledTo.current === `${session?.id}|${foundItem}`) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(foundItem)}"]`);
    if (!el) return;
    scrolledTo.current = `${session?.id}|${foundItem}`;
    unpin();
    el.scrollIntoView?.({ block: 'center' });
  });
  const resolveRef = (n: number) => historyRef(transcript, n);
  const mark = (id: string): Record<string, string> => (id === foundItem ? { 'data-item': id, 'data-found': '' } : { 'data-item': id });
  const answerTools = useMemo(
    () => (actions.openFolder ? { openFile: actions.openFile, openFolder: actions.openFolder, saveCsv: actions.saveCsv, cwd: session?.cwd } : null),
    [actions.openFile, actions.openFolder, actions.saveCsv, session?.cwd],
  );
  return (
    <AnswerToolsContext.Provider value={answerTools}>
    <OpenSessionContext.Provider value={actions.openFound ?? actions.openSession}>
    <HistoryRefContext.Provider value={resolveRef}>
    <HistoryCardsContext.Provider value={transcript.historyCards}>
    <ToolCardsContext.Provider value={transcript.fileCards}>
    <SourceCardsContext.Provider value={transcript.sourceCards}>
    <div className="conversation">
      <div className="transcript" ref={ref}>
        {items.length === 0 && !running ? (
          <EmptyState session={session} needsModel={needsModel} {...(onSetupModel ? { onSetupModel } : {})} />
        ) : (
          <div className="transcript-column">
            {found?.back ? (
              <button type="button" className="history-back" onClick={found.back.onBack}>
                <Icon name="back" size={14} />
                <span>返回「{found.back.title}」</span>
              </button>
            ) : null}
            {items.map((item, i) => {
              if (item.kind === 'user')
                return (
                  <div key={item.id} className="turn-mine">
                    <div className={item.steer ? 'turn-user is-steer' : 'turn-user'} {...mark(item.id)}>
                      {item.steer ? <span className="turn-user-tag">补充</span> : null}
                      <p className="turn-user-text">{item.text}</p>
                    </div>
                    {item.attachments?.some((a) => a.image) ? (
                      <div className="turn-pictures">
                        {item.attachments
                          .filter((a) => a.image)
                          .map((a) => (
                            <SentPicture key={a.image!.path} a={a} {...(actions.imageUrl ? { url: actions.imageUrl } : {})} />
                          ))}
                      </div>
                    ) : null}
                    {item.attachments?.some((a) => a.code) ? (
                      <p className="turn-note turn-attach-note status-with-icon">
                        <SpicaStatusIcon name="error" size={14} />
                        {item.attachments
                          .filter((a) => a.code)
                          .map((a) => `${a.name}：${IMAGE_CODE_TEXT[a.code!]}`)
                          .join('；')}
                      </p>
                    ) : null}
                    {item.attachments?.some((a) => !a.image && !a.code) ? (
                      <div className="turn-attachments">
                        <FileCards
                          files={item.attachments.filter((a) => !a.image && !a.code).map((a) => ({ path: a.path, tool: 'read_file', ...(a.file ? { card: a.file } : {}) }))}
                          onOpen={actions.openFile}
                          actions={fileActions(actions, session?.cwd)}
                        />
                      </div>
                    ) : null}
                    <MessageActions
                      mine
                      text={item.text}
                      at={item.at}
                      regenerate={
                        // A round that ended without any answer (an error before a word): 重新生成 from the message itself.
                        regen && actions.regenerate && item.id === regen.anchorId && items[i + 1]?.kind !== 'response' && !running
                          ? { state: regen, onRegenerate: () => actions.regenerate?.() }
                          : undefined
                      }
                    />
                  </div>
                );
              if (item.kind === 'mail') return <MailNote key={item.id} ids={item.mailIds} flagged={item.flagged} actions={actions} />;
              if (item.kind === 'settings') return <SettingsChangeCard key={item.id} change={item.change} onOpenSettings={actions.openModelSettings} />;
              if (item.kind === 'note')
                return item.child ? (
                  <ChildNoteCard key={item.id} note={item.child} onOpen={actions.openSession} />
                ) : (
                  <p key={item.id} className="turn-note" {...mark(item.id)}>
                    {item.text}
                  </p>
                );
              return <Response key={item.id} item={item} live={running && i === lastIndex} since={running && i === lastIndex ? transcript.run?.startedAt : undefined} after={lastIndex - i} regen={regen && session?.role === 'top' ? { state: regen, last: item.anchorId === regen.anchorId || items[i - 1]?.id === regen.anchorId } : undefined} actions={actions} cards={transcript.fileCards} lists={transcript.fileCardLists} sources={transcript.sourceCards} moved={moves.get(item.id)} cwd={session?.cwd} at={mark(item.id)} />;
            })}
            <StatusLine transcript={transcript} />
            {waiting.map((w) => (
              <div key={w.id} className="resume-row waiting-row" role="status">
                <span>
                  「{w.title}」{w.status === 'awaiting_confirm' ? '等待确认' : '等待回答'}
                </span>
                <button type="button" className="btn" onClick={() => actions.openSession(w.id)}>
                  处理
                </button>
              </div>
            ))}
            {session?.status === 'interrupted' && !running ? (
              <div className="resume-row">
                <span className="status-with-icon">
                  <SpicaStatusIcon name="warning" size={15} />
                  上次运行已中断
                </span>
                <button type="button" className="btn" onClick={actions.resume}>
                  继续
                </button>
              </div>
            ) : null}
            {transcript.error ? (
              <p className="turn-error status-with-icon" role="alert">
                <SpicaStatusIcon name="error" size={15} />
                {transcript.error}
              </p>
            ) : null}
          </div>
        )}
      </div>
      {/* Pinned to the top of the input area, so it sits just above the input box
          whatever its height (several lines, queued messages, zoom). */}
      <div className="to-bottom-anchor">
        {away ? (
          <button type="button" className="to-bottom" onClick={toBottom} aria-label="回到最新" title="回到最新">
            <Icon name="chevronDown" size={16} />
          </button>
        ) : null}
      </div>
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
      <Composer running={running} onSend={actions.send} onStop={actions.stop} sessionKey={session?.id ?? ''} {...(composerTools ? { tools: composerTools } : {})} />
      {demo ? <p className="composer-note">当前为演示数据</p> : null}
    </div>
    </SourceCardsContext.Provider>
    </ToolCardsContext.Provider>
    </HistoryCardsContext.Provider>
    </HistoryRefContext.Provider>
    </OpenSessionContext.Provider>
    </AnswerToolsContext.Provider>
  );
}

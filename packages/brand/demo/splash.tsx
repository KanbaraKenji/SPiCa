// 开机画面预览页：?theme=light|dark&ready=秒（多少秒后算加载完成）
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles/brand.css';
import { SpicaSplash } from '../src/react/SpicaSplash.tsx';

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const readyAfter = Number(q.get('ready') ?? '4.8');

function Demo() {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), readyAfter * 1000);
    return () => clearTimeout(t);
  }, []);
  if (done) return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>开机画面已结束</div>;
  return <SpicaSplash ready={ready} theme={theme} caption="v0.1.0" onDone={() => setDone(true)} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);

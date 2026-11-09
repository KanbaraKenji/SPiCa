import { useEffect, useState } from 'react';
import { SpicaMark } from './mark/SpicaMark';

export function App() {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    window.spica
      .getAppInfo()
      .then((info) => {
        if (alive) setVersion(info.version);
      })
      .catch(() => {
        if (alive) setVersion('');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="splash">
      <SpicaMark size={112} title="Spica" />
      <h1 className="name">Spica</h1>
      <p className="version">{version ? `v${version}` : ' '}</p>
    </main>
  );
}

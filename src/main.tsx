import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './styles/hud.css';
import './styles/features.css';
import './styles/odds.css';
import './styles/tape.css';
import './styles/labs-glass.css';
import { startLabsUI } from './lib/labs-ui-init';
import { App } from './app/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startLabsUI();

// Production builds keep the app shell available for quick starts; live data is never cached (see public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

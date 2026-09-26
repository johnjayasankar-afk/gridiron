import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { announceEmbed } from '../shared/embed.js';
import { installTrackingProbe } from './field/trackingProbe';
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

// A page that framed this one cannot tell a blocked frame from a loaded one, so
// it shows a still until this arrives. Sent as soon as the root has rendered,
// not from a requestAnimationFrame: a cross-origin frame the embedding page has
// not revealed yet is occluded, and Chrome defers its animation frames until it
// is, which is a deadlock. Running at all is the signal, because a frame the
// browser refused runs nothing.
announceEmbed();

// Behind ?probe=tracking, and installs nothing without it: measures whether the
// fields stay on their cards while the page scrolls, in the browser it is being
// asked about. See src/field/trackingProbe.ts.
installTrackingProbe();

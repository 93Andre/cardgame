import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Service-worker update handling. vite-plugin-pwa is configured with
// `registerType: 'autoUpdate'`, which installs new SWs in the
// background — but the running tab keeps executing the old JS until
// the user manually reloads. `controllerchange` fires once the new SW
// takes over; we then reload so the user is on current code. Guarded
// to a single reload per session (some browsers fire the event twice).
if ('serviceWorker' in navigator) {
  let didReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (didReload) return;
    didReload = true;
    window.location.reload();
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

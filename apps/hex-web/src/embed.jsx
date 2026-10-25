import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import css from './App.css?inline';

export function mount(container, { session, config }) {
  const shadow = container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css.replace(':root', ':host').replace(/\bbody\s*\{/, '.hex-shell {');
  shadow.append(style);
  const root = document.createElement('div');
  shadow.append(root);
  createRoot(root).render(
    <div className="hex-shell">
      <App session={session} initialConfig={config} />
    </div>,
  );
}

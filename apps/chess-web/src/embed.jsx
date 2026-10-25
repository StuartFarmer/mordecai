import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import css from './App.css?inline';
export function mount(container, { session, config }) {
  const shadow = container.attachShadow({ mode: 'open' }),
    style = document.createElement('style'),
    root = document.createElement('div');
  style.textContent = css;
  shadow.append(style, root);
  const reactRoot = createRoot(root);
  reactRoot.render(<App session={session} config={config} />);
  return () => reactRoot.unmount();
}

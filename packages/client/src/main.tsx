import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

// Socket connection is deferred until the user enters from the setup page
const root = document.getElementById('root')!;
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

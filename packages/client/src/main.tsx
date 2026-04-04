import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './ui/ThemeContext';
import { AppShell } from './ui/views/AppShell';

// Socket connection is deferred until the user enters from the setup page
const root = document.getElementById('root')!;
createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  </React.StrictMode>,
);

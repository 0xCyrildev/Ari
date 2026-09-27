import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import { RouterProvider } from './app/router';
import { TooltipProvider } from './components/ui';
import { Root } from './app/Root';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider>
      <TooltipProvider>
        <Root />
      </TooltipProvider>
    </RouterProvider>
  </StrictMode>,
);

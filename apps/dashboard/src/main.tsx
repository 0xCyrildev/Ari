import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { RouterProvider } from './app/router';
import { Root } from './app/Root';
import { TooltipProvider } from './components/ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider>
      <TooltipProvider>
        <Root />
      </TooltipProvider>
    </RouterProvider>
  </StrictMode>,
);

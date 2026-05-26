import React from 'react';
import ReactDOM from 'react-dom/client';
import { ProviderVaultWebMode } from './components/ProviderVaultWebMode';
import './App.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const isDaveTvHostedBuild = import.meta.env.VITE_DAVETV_HOSTED === '1';
const isHostedWeb = typeof window !== 'undefined' && !(window as any).__TAURI_INTERNALS__;

if (isDaveTvHostedBuild || isHostedWeb) {
  root.render(
    <React.StrictMode>
      <ProviderVaultWebMode />
    </React.StrictMode>
  );
} else {
  import('./services/tauri-bridge').then(() => {
    Promise.all([
      import('./App'),
      import('./contexts/SourceVersionContext'),
    ]).then(([{ default: App }, { SourceVersionProvider }]) => {
      root.render(
        <React.StrictMode>
          <SourceVersionProvider>
            <App />
          </SourceVersionProvider>
        </React.StrictMode>
      );
    });
  });
}

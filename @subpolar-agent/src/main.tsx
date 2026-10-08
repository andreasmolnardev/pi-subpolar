import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerServiceWorker } from './lib/serviceWorker'
import { createApiCompletionSuggestionProvider } from './hooks/useCompletionSuggestions'

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <App suggestionProvider={createApiCompletionSuggestionProvider()} />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
)

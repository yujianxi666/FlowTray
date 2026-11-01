import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installFlowTrayApi } from './api'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shelf.css'
import './styles/settings.css'
import './styles/overlays.css'

installFlowTrayApi()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)

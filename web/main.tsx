import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento de montagem do Horizonte não encontrado.');
createRoot(root).render(<App />);

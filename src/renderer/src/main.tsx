import { createRoot } from 'react-dom/client'
import { IpcBridge } from './bridge/bridge'
import { MainWindow } from './MainWindow'
import './styles.css'

createRoot(document.getElementById('root')!).render(<MainWindow bridge={new IpcBridge()} />)

import { useEffect } from 'react'
import './App.css'
import { ApplyReviewModal } from './components/ApplyReviewModal'
import { DetailPanel } from './components/DetailPanel'
import { EditTrackOverlay } from './components/EditTrackOverlay'
import { FolderBrowser } from './components/FolderBrowser'
import { RulesSidebar } from './components/RulesSidebar'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toast } from './components/Toast'
import { TrackTable } from './components/TrackTable'
import { useStore } from './store-context'

function App() {
  const { init, folderBrowserOpen, editTrackPath } = useStore()

  useEffect(() => {
    init()
  }, [init])

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <RulesSidebar />
        <div className="main-area">
          <TrackTable />
          <StatusBar />
          <DetailPanel />
        </div>
      </div>
      {folderBrowserOpen && <FolderBrowser />}
      {editTrackPath && <EditTrackOverlay />}
      <ApplyReviewModal />
      <Toast />
    </div>
  )
}

export default App

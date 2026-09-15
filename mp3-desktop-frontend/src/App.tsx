import { useEffect } from 'react'
import './App.css'
import { ApplyReviewModal } from './components/ApplyReviewModal'
import { DetailPanel } from './components/DetailPanel'
import { EditTrackOverlay } from './components/EditTrackOverlay'

import { RulesSidebar } from './components/RulesSidebar'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toast } from './components/Toast'
import { TrackTable } from './components/TrackTable'
import { PickerInputs } from './pickers'
import { useStore } from './store-context'

function App() {
  const { init, editTrackPath } = useStore()

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
      {editTrackPath && <EditTrackOverlay />}
      <ApplyReviewModal />
      <PickerInputs />
      <Toast />
    </div>
  )
}

export default App

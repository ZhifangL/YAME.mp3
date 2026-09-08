import { useStore } from '../store-context'

export function Toast() {
  const { toast } = useStore()
  if (!toast) return null
  return <div className={'toast ' + toast.kind}>{toast.text}</div>
}

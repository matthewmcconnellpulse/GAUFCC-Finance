import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[50vh] grid place-items-center px-6 text-center">
          <div>
            <h1 className="font-display text-[22px] text-ink">Something went wrong</h1>
            <p className="text-stone-500 text-[12.5px] mt-2 max-w-md">
              The error has been logged to the console. Refresh to carry on — nothing has been
              lost.
            </p>
            <Button
              variant="ghost"
              className="mt-4"
              onClick={() => {
                this.setState({ error: null })
                window.location.reload()
              }}
            >
              Reload page
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

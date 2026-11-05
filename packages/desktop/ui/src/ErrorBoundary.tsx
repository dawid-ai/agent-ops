import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Shows a render error with a way back, instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`render error: ${error.message}\n${info.componentStack ?? ''}`);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-lg text-zinc-200">Something went wrong in this view</div>
        <pre className="max-w-2xl whitespace-pre-wrap text-sm text-red-300">
          {this.state.error.message}
        </pre>
        <button
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}

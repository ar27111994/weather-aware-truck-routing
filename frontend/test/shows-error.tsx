import { Component, type ReactNode } from "react";

/** Props for {@link ShowsError}. */
interface ShowsErrorProps {
  readonly children: ReactNode;
}

/**
 * What the route's error boundary does, in the part that matters to a test: a render error under
 * it is replaced by an alert with the error's message.
 */
export class ShowsError extends Component<ShowsErrorProps, { readonly error: Error | null }> {
  override state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : <p role="alert">{error.message}</p>;
  }
}

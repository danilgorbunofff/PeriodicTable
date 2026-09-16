"use client";
import { useEffect } from "react";
import { installClientErrorHandlers } from "../lib/clientError";

/**
 * Installs the browser error handlers (Phase 18, R18-1, R18-10).
 *
 * It renders nothing and does nothing on the server. `useEffect` is the reason it
 * is a component rather than a script: the handlers must not be registered while
 * hydrating (a React hydration mismatch is noise, not an incident) and they must
 * be unregistered when the tree unmounts, which a module-level side effect cannot
 * promise.
 *
 * Mounted from the root layout, so it covers every route. The failures it exists
 * for are the ones the render boundaries cannot see — a throw inside a timer or
 * an event handler, a rejected promise nobody handled, and a third-party script.
 */
export default function ClientErrorReporter() {
  useEffect(() => installClientErrorHandlers(), []);
  return null;
}

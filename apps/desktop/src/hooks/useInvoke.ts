import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseInvokeOptions<T> {
  /** Skip the invoke call when false. Defaults to true. */
  enabled?: boolean;
  /** Called with the result on success. */
  onSuccess?: (data: T) => void;
  /** Called with the error on failure. */
  onError?: (error: unknown) => void;
}

interface UseInvokeResult<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  /** Re-run the invoke call. Returns the result or undefined on error. */
  refetch: () => Promise<T | undefined>;
}

/**
 * Hook that wraps a Tauri `invoke()` call with loading/error state.
 * Re-fetches automatically when `command` or `args` change.
 */
export function useInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: UseInvokeOptions<T>,
): UseInvokeResult<T> {
  const enabled = options?.enabled ?? true;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const onSuccess = options?.onSuccess;
  const onError = options?.onError;

  // Stable serialized key for args so we can use it as a dependency
  const argsKey = args ? JSON.stringify(args) : "";

  // Keep latest callbacks in refs to avoid re-triggering the effect
  const callbacksRef = useRef({ onSuccess, onError });
  callbacksRef.current = { onSuccess, onError };

  const fetchData = useCallback(async (): Promise<T | undefined> => {
    setLoading(true);
    setError(null);
    try {
      const parsedArgs = argsKey ? JSON.parse(argsKey) : undefined;
      const result = await invoke<T>(command, parsedArgs);
      setData(result);
      callbacksRef.current.onSuccess?.(result);
      return result;
    } catch (e) {
      setError(e);
      callbacksRef.current.onError?.(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [command, argsKey]);

  useEffect(() => {
    if (!enabled) return;
    fetchData();
  }, [enabled, fetchData]);

  return { data, loading, error, refetch: fetchData };
}

/** Runs an async action with shared loading / error handling. */
export async function runTracked(
  setBusy: (busy: boolean) => void,
  setErr: (msg: string | null) => void,
  fn: () => Promise<void>,
): Promise<void> {
  setBusy(true);
  setErr(null);
  try {
    await fn();
  } catch (e) {
    setErr(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
}

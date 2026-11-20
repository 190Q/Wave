export async function reportInitialization(
  initialize: () => Promise<string | null>,
  waitForArtwork: () => Promise<void>,
  device: () => string,
  report: (ready: boolean, detail: string) => Promise<void>,
): Promise<void> {
  try {
    const error = await initialize();
    if (error) throw new Error(error);
    await waitForArtwork();
    void report(true, device()).catch(() => {});
  } catch (error) {
    void report(false, String(error)).catch(() => {});
  }
}

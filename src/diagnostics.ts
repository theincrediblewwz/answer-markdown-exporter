export const DIAGNOSTICS_MESSAGE = 'gpt-md:diagnostics';
export interface PageDiagnostics {
  version: string;
  host: string;
  readyState: DocumentReadyState;
  answerCount: number;
  controlCount: number;
  visibleControlCount: number;
  selectorCounts: Record<string, number>;
  error: string | null;
}

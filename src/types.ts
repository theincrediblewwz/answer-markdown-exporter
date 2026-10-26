export interface Diagnostic { code: string; message: string; severity: 'warning' | 'info'; }
export interface FormulaRecord {
  rawSource: string; tex: string; display: boolean;
  sourceKind: 'attribute' | 'annotation' | 'mathml' | 'missing';
}
export interface CodeRecord { text: string; language: string | null; }
export interface ExportResult {
  markdown: string; diagnostics: Diagnostic[]; formulas: FormulaRecord[]; codeBlocks: CodeRecord[];
}
export interface PreviewResult { html: string; diagnostics: Diagnostic[]; }

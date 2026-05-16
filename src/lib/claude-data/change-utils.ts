import type { ChangeTotals } from './types';

export function makeChangeTotals({
  addedLines = 0,
  removedLines = 0,
  fileCount = 0,
  editCount = 0,
}: Partial<Pick<ChangeTotals, 'addedLines' | 'removedLines' | 'fileCount' | 'editCount'>> = {}): ChangeTotals {
  return {
    addedLines,
    removedLines,
    netLineDelta: addedLines - removedLines,
    changedLines: addedLines + removedLines,
    fileCount,
    editCount,
  };
}

export function zeroChangeTotals(): ChangeTotals {
  return makeChangeTotals();
}

export function addChangeTotals(left: ChangeTotals, right?: ChangeTotals): ChangeTotals {
  return makeChangeTotals({
    addedLines: left.addedLines + (right?.addedLines || 0),
    removedLines: left.removedLines + (right?.removedLines || 0),
    fileCount: left.fileCount + (right?.fileCount || 0),
    editCount: left.editCount + (right?.editCount || 0),
  });
}

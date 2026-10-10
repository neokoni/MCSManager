import type { IBuffer } from "@xterm/xterm";

export function snapSelectionStart(buffer: IBuffer, columns: number, index: number): number {
  const row = Math.floor(index / columns);
  let column = index % columns;
  const line = buffer.getLine(row);

  while (column > 0 && line?.getCell(column)?.getWidth() === 0) {
    column--;
  }

  return row * columns + column;
}

export function snapSelectionEnd(buffer: IBuffer, columns: number, index: number): number {
  if (index % columns === 0) return index;

  const row = Math.floor(index / columns);
  let column = index % columns;
  const line = buffer.getLine(row);

  while (column < columns && line?.getCell(column)?.getWidth() === 0) {
    column++;
  }

  return row * columns + column;
}

declare module 'easystarjs' {
  export default class EasyStar {
    setGrid(grid: number[][]): void;
    setAcceptableTiles(tiles: number[]): void;
    findPath(
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      callback: (path: Array<{ x: number; y: number }> | null) => void,
    ): void;
    calculate(): void;
    setIterationsPerCalculation(iterations: number): void;
    avoidAdditionalPoint(x: number, y: number): void;
    enableDiagonals(): void;
    disableDiagonals(): void;
  }
}

declare module 'd3-org-chart' {
  export class OrgChart {
    container(container: HTMLElement | string): this
    data(data: unknown[]): this
    nodeWidth(fn: (d: unknown) => number): this
    nodeHeight(fn: (d: unknown) => number): this
    compactMarginBetween(fn: (d: unknown) => number): this
    onNodeClick(fn: (node: unknown) => void): this
    nodeContent(fn: (node: unknown) => string): this
    render(): this
    getChartState?(): {
      lastTransform?: { x: number; y: number; k: number }
      svg?: { call: (behavior: unknown, ...args: unknown[]) => unknown }
      zoomBehavior?: { transform: unknown }
    }
  }
}

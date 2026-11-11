// Stands in for elkjs (EPL-2.0), which mermaid loads only for charts that ask for the elk layout: the app ships only
// permissively licensed code, so that layout is left out. Such a chart fails to draw and stays a code block.
export default class ELK {
  constructor() {
    throw new Error('The elk layout is not included.');
  }
}

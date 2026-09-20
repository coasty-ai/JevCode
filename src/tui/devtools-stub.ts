// Empty stand-in for the optional peer react-devtools-core, aliased in at build time (DESIGN.md §12).
const devtools: { connectToDevTools: (opts?: unknown) => void } = { connectToDevTools: () => undefined };
export default devtools;
export const connectToDevTools = devtools.connectToDevTools;
